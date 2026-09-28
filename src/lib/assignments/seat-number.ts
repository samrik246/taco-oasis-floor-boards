import type { Prisma } from "@prisma/client";
import { familyForStation, PAINT_FAMILIES } from "@/lib/assignments/paint-families";

/** Seats of a family that holds more than one person. One-seat families stay unnumbered. */
export function numberedFamilySeats(stationId: string): readonly string[] | null {
  const family = familyForStation(stationId);
  if (!family) return null;
  const seats = PAINT_FAMILIES[family];
  return seats.length >= 2 ? seats : null;
}

export function familySeatIndex(stationId: string): number {
  const seats = numberedFamilySeats(stationId);
  if (!seats) return Number.MAX_SAFE_INTEGER;
  const index = seats.indexOf(stationId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/** Lowest integer from 1 that nobody in the set already holds. */
export function lowestFreeSeatNumber(taken: Iterable<number>): number {
  const used = new Set<number>();
  for (const n of taken) {
    if (Number.isInteger(n) && n >= 1) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/**
 * Keep a number this person already holds in the family at this hour.
 * Otherwise take the lowest number nobody else holds. Stations outside a
 * numbered family stay null. Leaving neighbors does not renumber anyone.
 */
export function decideSeatNumber(input: {
  stationId: string;
  prior: number | null;
  heldByOthers: readonly number[];
}): number | null {
  if (!numberedFamilySeats(input.stationId)) return null;
  if (input.prior != null && input.prior >= 1) return input.prior;
  return lowestFreeSeatNumber(input.heldByOthers);
}

export type SeatNumberSource = {
  id: string;
  stationId: string;
  hourStartMs: number;
  seatNumber: number | null;
};

/**
 * Fill a missing number for a read. Stored numbers stay. A null number takes
 * the lowest free, and null rows are visited in family-seat order. Nothing
 * here is written.
 */
export function fillMissingSeatNumbers(rows: readonly SeatNumberSource[]): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const groups = new Map<string, SeatNumberSource[]>();
  for (const row of rows) {
    const family = familyForStation(row.stationId);
    const seats = family ? PAINT_FAMILIES[family] : null;
    if (!family || !seats || seats.length < 2) {
      result.set(row.id, null);
      continue;
    }
    const key = `${row.hourStartMs}|${family}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const ordered = [...list].sort(
      (a, b) => familySeatIndex(a.stationId) - familySeatIndex(b.stationId) || a.id.localeCompare(b.id),
    );
    const used = new Set<number>();
    for (const row of ordered) {
      if (row.seatNumber != null && row.seatNumber >= 1) used.add(row.seatNumber);
    }
    for (const row of ordered) {
      if (row.seatNumber != null && row.seatNumber >= 1) {
        result.set(row.id, row.seatNumber);
        continue;
      }
      const n = lowestFreeSeatNumber(used);
      used.add(n);
      result.set(row.id, n);
    }
  }
  return result;
}

/**
 * The number to store on a new or replaced row, inside the caller's transaction.
 * A legacy null in the same family-hour is stored on this write so the next
 * read matches what the board already showed.
 */
function heldNumbers(values: readonly number[]): number[] {
  return values.filter((n) => Number.isInteger(n) && n >= 1);
}

/**
 * The number a read would show for this row among its family-hour peers.
 * Stored numbers win. A null takes the lowest free, in family-seat order.
 */
export function readBackSeatNumber(
  row: { id: string; stationId: string; seatNumber: number | null },
  peers: readonly { id: string; stationId: string; seatNumber: number | null }[],
  hourStartMs: number,
): number | null {
  if (!numberedFamilySeats(row.stationId)) return null;
  const family = familyForStation(row.stationId);
  const group = [row, ...peers.filter((peer) => peer.id !== row.id && familyForStation(peer.stationId) === family)];
  return fillMissingSeatNumbers(group.map((peer) => ({
    id: peer.id,
    stationId: peer.stationId,
    hourStartMs,
    seatNumber: peer.seatNumber,
  }))).get(row.id) ?? null;
}

/**
 * A person keeps the number a read already showed when the destination stays
 * in that same numbered family. A family change carries nothing.
 */
export function carriedSeatNumber(input: {
  fromStationId: string;
  toStationId: string;
  row: { id: string; stationId: string; seatNumber: number | null };
  peers: readonly { id: string; stationId: string; seatNumber: number | null }[];
  hourStartMs: number;
}): number | null {
  const from = familyForStation(input.fromStationId);
  const to = familyForStation(input.toStationId);
  if (!from || from !== to || !numberedFamilySeats(input.toStationId)) return null;
  return readBackSeatNumber(input.row, input.peers, input.hourStartMs);
}

export type PaintSeatEdit = {
  key: string;
  employeeId: string;
  hourStartMs: number;
  /** Concrete station after family resolution. Null clears the hour. */
  stationId: string | null;
  previous: { id: string; stationId: string; seatNumber: number | null } | null;
};

export type UntouchedSeatRow = {
  id: string;
  employeeId: string;
  stationId: string;
  hourStartMs: number;
  seatNumber: number | null;
};

/**
 * Numbers for one paint save. People who stay in the family reserve the
 * number a read already showed, before any newcomer is given one, so request
 * order cannot hand that number to someone else. Untouched legacy nulls in a
 * touched family-hour are listed for the caller to store.
 */
export function planPaintSeatNumbers(
  edits: readonly PaintSeatEdit[],
  untouched: readonly UntouchedSeatRow[],
): { numbers: Map<string, number | null>; persist: { id: string; seatNumber: number }[] } {
  const numbers = new Map<string, number | null>();
  const persist: { id: string; seatNumber: number }[] = [];
  for (const edit of edits) numbers.set(edit.key, null);

  const groups = new Map<string, { hourStartMs: number; family: PaintFamilyKey }>();
  const note = (stationId: string | null | undefined, hourStartMs: number) => {
    if (!stationId || !numberedFamilySeats(stationId)) return;
    const family = familyForStation(stationId);
    if (!family) return;
    groups.set(`${hourStartMs}|${family}`, { hourStartMs, family });
  };
  for (const edit of edits) {
    note(edit.stationId, edit.hourStartMs);
    note(edit.previous?.stationId, edit.hourStartMs);
  }

  for (const { hourStartMs, family } of groups.values()) {
    const seats = PAINT_FAMILIES[family];
    const inFamily = (stationId: string) => (seats as readonly string[]).includes(stationId);
    const previousRows = edits.flatMap((edit) => {
      if (!edit.previous || edit.hourStartMs !== hourStartMs || !inFamily(edit.previous.stationId)) return [];
      return [{
        id: edit.previous.id,
        stationId: edit.previous.stationId,
        hourStartMs,
        seatNumber: edit.previous.seatNumber,
      }];
    });
    const stayUntouched = untouched.filter((row) => row.hourStartMs === hourStartMs && inFamily(row.stationId));
    const filled = fillMissingSeatNumbers([...stayUntouched, ...previousRows]);
    const reserved = new Set<number>();
    for (const row of stayUntouched) {
      const n = filled.get(row.id);
      if (n != null) reserved.add(n);
      if (row.seatNumber == null && n != null) persist.push({ id: row.id, seatNumber: n });
    }
    const stayingKeys = new Set<string>();
    for (const edit of edits) {
      if (edit.hourStartMs !== hourStartMs || !edit.stationId || !edit.previous) continue;
      if (!inFamily(edit.stationId) || !inFamily(edit.previous.stationId)) continue;
      stayingKeys.add(edit.key);
      const n = filled.get(edit.previous.id) ?? null;
      numbers.set(edit.key, n);
      if (n != null) reserved.add(n);
    }
    for (const edit of edits) {
      if (edit.hourStartMs !== hourStartMs || !edit.stationId || !inFamily(edit.stationId)) continue;
      if (stayingKeys.has(edit.key)) continue;
      const n = lowestFreeSeatNumber(reserved);
      reserved.add(n);
      numbers.set(edit.key, n);
    }
  }
  return { numbers, persist };
}

type PaintFamilyKey = keyof typeof PAINT_FAMILIES;

export async function seatNumberForWrite(
  tx: Prisma.TransactionClient,
  input: {
    stationId: string;
    hourStart: Date;
    employeeId: string;
    /** This person's number before the write. Null means they did not hold one. */
    prior?: number | null;
    ignoreIds?: string[];
    /** Numbers held by rows this call cannot see, such as the other swap partner. */
    reserved?: readonly number[];
  },
): Promise<number | null> {
  const seats = numberedFamilySeats(input.stationId);
  if (!seats) return null;
  const rows = await tx.assignment.findMany({
    where: {
      hourStart: input.hourStart,
      stationId: { in: [...seats] },
      ...(input.ignoreIds?.length ? { id: { notIn: input.ignoreIds } } : {}),
    },
    select: { id: true, employeeId: true, stationId: true, seatNumber: true },
  });
  const others = rows.filter((row) => row.employeeId !== input.employeeId);
  const reserved = heldNumbers(input.reserved ?? []);
  const ownPrior = input.prior != null && input.prior >= 1 ? [input.prior] : [];
  const occupy = [...ownPrior, ...reserved];
  const filled = fillMissingSeatNumbers([
    ...others.map((row) => ({
      id: row.id,
      stationId: row.stationId,
      hourStartMs: input.hourStart.getTime(),
      seatNumber: row.seatNumber,
    })),
    ...occupy.map((n, index) => ({
      id: `__reserved_${index}`,
      stationId: seats[0]!,
      hourStartMs: input.hourStart.getTime(),
      seatNumber: n,
    })),
  ]);
  for (const row of others) {
    const n = filled.get(row.id);
    if (row.seatNumber == null && n != null) {
      await tx.assignment.update({ where: { id: row.id }, data: { seatNumber: n } });
    }
  }
  const heldByOthers = [
    ...others.flatMap((row) => {
      const n = row.seatNumber != null && row.seatNumber >= 1 ? row.seatNumber : filled.get(row.id);
      return n != null ? [n] : [];
    }),
    ...reserved,
  ];
  return decideSeatNumber({
    stationId: input.stationId,
    prior: input.prior === undefined ? null : input.prior,
    heldByOthers,
  });
}
