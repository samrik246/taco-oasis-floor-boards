import { quarterState } from "@/lib/quarter/schema";
import { decisionPaints } from "@/lib/quarter/decision-paint";
import { formatInTimeZone } from "date-fns-tz";
import type { Prisma } from "@prisma/client";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { BOARD_CHANGE_ROUTES, writeBoardChange } from "@/lib/board-change-log";
import {
  findHandoffOverlay,
  overlayCoversWindow,
  paintStationAt,
} from "@/lib/breaks/handoff-cover";
import { assessBreak, withStaffBreakLock } from "@/lib/breaks/rules";
import { TIMEZONE } from "@/lib/constants";
import { isDefaultMandatory, MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { loadOverlayRecords, screenOverlays, toSliceOverlay, type OverlayKind } from "@/lib/overlays/read";
import { resolveOverlayWindow, type OverlayWindowMode } from "@/lib/overlays/windows";
import { assessStarGate } from "@/lib/slices/break-gate";
import {
  buildDaySlices,
  type DaySlices,
  type SliceBreak,
  type SlicePaint,
  type SliceShift,
} from "@/lib/slices/day-slices";
import { chicagoToday } from "@/lib/upcoming/source";

export class OverlayRefused extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type Manager = { id: string; name: string };

type LiveShift = {
  id: string;
  employeeId: string;
  board: string;
  startAt: Date;
  endAt: Date;
  supersededAt: Date | null;
  boardRemoved: boolean;
};

function clock(instant: Date): string {
  return formatInTimeZone(instant, TIMEZONE, "HH:mm");
}

function asSliceShift(shift: LiveShift): SliceShift {
  return {
    id: shift.id,
    employeeId: shift.employeeId,
    board: shift.board,
    startAt: shift.startAt,
    endAt: shift.endAt,
    superseded: false,
    boardRemoved: false,
  };
}

function coveringShift(
  shifts: readonly LiveShift[],
  employeeId: string,
  start: Date,
  end: Date,
  board: string,
): LiveShift | null {
  return shifts.find((shift) => {
    return shift.employeeId === employeeId
      && shift.board === board
      && start.getTime() >= shift.startAt.getTime()
      && end.getTime() <= shift.endAt.getTime();
  }) ?? null;
}

function slicesInside(day: DaySlices, start: Date, end: Date) {
  return day.slices.filter((slice) => {
    return slice.start.getTime() >= start.getTime() && slice.end.getTime() <= end.getTime();
  });
}

function heldStation(day: DaySlices, employeeId: string, start: Date, end: Date): string | null {
  const inside = slicesInside(day, start, end);
  if (inside.length === 0) return null;
  let held: string | null = null;
  for (const slice of inside) {
    const stationId = slice.people.find((person) => person.employeeId === employeeId)?.stationId ?? null;
    if (!stationId) return null;
    if (held != null && held !== stationId) return null;
    held = stationId;
  }
  return held;
}

function stationTaken(day: DaySlices, stationId: string, employeeId: string, start: Date, end: Date): boolean {
  return slicesInside(day, start, end).some((slice) => {
    return slice.seats.some((seat) => seat.stationId === stationId && seat.employeeId !== employeeId);
  });
}

async function canDoSeat(
  tx: Prisma.TransactionClient,
  employeeId: string,
  stationId: string,
): Promise<boolean> {
  const stored = await tx.employeeStationAbility.findUnique({
    where: { employeeId_stationId: { employeeId, stationId } },
    select: { level: true },
  });
  const defaults = await loadColumnDefaults(tx);
  return levelWhenUnset(stored?.level, defaults.get(stationId)) !== "forbidden";
}

async function logOverlay(
  tx: Prisma.TransactionClient,
  actor: Manager,
  route: string,
  row: { date: string; board: string; kind: OverlayKind; employeeId: string; startAt: Date; endAt: Date },
  end?: "cancel" | "import",
): Promise<void> {
  const board = row.board === "caja" || row.board === "cocina" ? row.board : undefined;
  await writeBoardChange(tx, { id: actor.id, name: actor.name, route }, {
    date: row.date,
    board,
    employeeId: row.employeeId,
    breakStart: clock(row.startAt),
    breakEnd: clock(row.endAt),
    overlay: row.kind,
    overlayEnd: end,
    count: 1,
  });
}

const IMPORT_ACTOR = { id: "import", name: "Import" };
const QUARTER_MS = 15 * 60 * 1000;

async function liveOtherBreaks(
  tx: Prisma.TransactionClient,
  date: string,
  employeeId: string,
): Promise<{ board: string; startAt: Date; endAt: Date; status: string }[]> {
  const others = await tx.staffBreak.findMany({
    where: { date, employeeId: { not: employeeId } },
    select: { shiftId: true, board: true, startAt: true, endAt: true, status: true },
  });
  if (others.length === 0) return [];
  const live = await tx.shift.findMany({
    where: {
      id: { in: others.map((row) => row.shiftId) },
      supersededAt: null,
      boardRemoved: false,
    },
    select: { id: true },
  });
  const liveIds = new Set(live.map((row) => row.id));
  return others.flatMap((row) => {
    if (!liveIds.has(row.shiftId)) return [];
    return [{ board: row.board, startAt: row.startAt, endAt: row.endAt, status: row.status }];
  });
}

/**
 * Star gate for a named cover, with the handoff overlay left out.
 * The name stands only when that overlay covers the window start to end.
 */
async function starAcceptsNamedCover(
  tx: Prisma.TransactionClient,
  input: {
    board: "caja" | "cocina";
    date: string;
    employeeId: string;
    shiftId: string;
    startAt: Date;
    endAt: Date;
    coverEmployeeId: string;
    ignoreOverlayId: string;
    shifts: readonly LiveShift[];
  },
): Promise<boolean> {
  const marks = await tx.mandatoryMark.findMany({
    where: { board: input.board, date: input.date },
    select: { stationId: true },
  });
  const extra = marks.map((mark) => mark.stationId).filter((id) => !isDefaultMandatory(id));
  const starStationIds = [...MANDATORY_STATIONS_BY_BOARD[input.board], ...extra];
  const paints: SlicePaint[] = await decisionPaints(tx, input.date);
  const canonical=(await quarterState(tx))?.phase === "active";
  const stored = await tx.staffBreak.findMany({
    where: { date: input.date },
    select: {
      employeeId: true,
      shiftId: true,
      board: true,
      startAt: true,
      endAt: true,
      status: true,
      coverEmployeeId: true,
      coverShiftId: true,
      shuffleShiftId: true,
      shuffleEmployeeId: true,
      auto: true,
    },
  });
  const breaks: SliceBreak[] = stored.flatMap((row) => {
    if (row.status !== "booked" && row.status !== "pending") return [];
    if (row.board !== "caja" && row.board !== "cocina") return [];
    return [{
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      board: row.board,
      startAt: row.startAt,
      endAt: row.endAt,
      status: row.status,
      coverEmployeeId: row.coverEmployeeId,
      ...(canonical?{coverShiftId:row.coverShiftId,shuffleShiftId:row.shuffleShiftId}:{}),
      shuffleEmployeeId: row.shuffleEmployeeId,
      auto: row.auto,
    }];
  });
  const overlays = (await loadOverlayRecords(tx, canonical?null:input.board, input.date)).map(row=>({...toSliceOverlay(row),...(canonical?{board:row.board}:{})}));
  const seat = paintStationAt(paints, input.employeeId, input.shiftId, input.startAt);
  const matched = findHandoffOverlay(overlays, input.coverEmployeeId, seat, starStationIds);
  const known = overlays.find((row) => row.id === input.ignoreOverlayId) ?? null;
  const handoff = matched ?? known;
  if (handoff && !overlayCoversWindow(handoff, input.startAt, input.endAt)) return false;
  const excludeId = handoff?.id ?? input.ignoreOverlayId;
  const star = assessStarGate({
    canonical,requesterShiftId:input.shiftId,
    date: input.date,
    board: input.board,
    employeeId: input.employeeId,
    startAt: input.startAt,
    endAt: input.endAt,
    shifts: input.shifts.map(asSliceShift),
    paints,
    breaks,
    starStationIds,
    overlays: overlays.filter((row) => row.id !== excludeId),
    coverEmployeeId: input.coverEmployeeId,
  });
  return !("code" in star);
}

/** Ceiling and star gate for a cover already named on a pending row. */
async function handedBooking(
  tx: Prisma.TransactionClient,
  input: {
    board: "caja" | "cocina";
    date: string;
    employeeId: string;
    shiftId: string;
    startAt: Date;
    endAt: Date;
    coverEmployeeId: string;
    ignoreOverlayId: string;
    shifts: readonly LiveShift[];
  },
): Promise<"book" | "roll" | "wait"> {
  const decision = assessBreak({
    date: input.date,
    startAt: input.startAt,
    endAt: input.endAt,
    shifts: input.shifts.filter((shift) => shift.employeeId === input.employeeId),
    otherBreaks: await liveOtherBreaks(tx, input.date, input.employeeId),
  });
  if ("code" in decision) return decision.code === "CEILING" ? "roll" : "wait";
  const accepted = await starAcceptsNamedCover(tx, input);
  return accepted ? "book" : "wait";
}

/**
 * A star seat handed to someone names that person only when this overlay
 * covers the whole break, start to end, and their shift covers it too.
 * A partial overlap leaves the row untouched. The lock is already held.
 * The star gate runs with this overlay left out. Only that decision books,
 * and only by a conditional write. A full ceiling leaves the row pending
 * and rolls one quarter. The name stays only when this overlay covers that
 * next quarter and the same gate accepts it.
 */
async function handStar(
  tx: Prisma.TransactionClient,
  input: {
    board: "caja" | "cocina";
    date: string;
    stationId: string;
    arrivingId: string;
    start: Date;
    end: Date;
    shifts: readonly LiveShift[];
    stars: ReadonlySet<string>;
    ignoreOverlayId: string;
  },
): Promise<void> {
  if (!input.stars.has(input.stationId)) return;
  const breaks = await tx.staffBreak.findMany({
    where: { board: input.board, date: input.date, status: { in: ["pending", "booked"] } },
  });
  for (const row of breaks) {
    if (row.employeeId === input.arrivingId) continue;
    if (input.start.getTime() > row.startAt.getTime() || input.end.getTime() < row.endAt.getTime()) continue;
    const paints = await decisionPaints(tx, input.date);
    if (paintStationAt(paints,row.employeeId,row.shiftId,row.startAt) !== input.stationId) continue;
    const coverShift = coveringShift(input.shifts, input.arrivingId, row.startAt, row.endAt, input.board);
    if (!coverShift) continue;
    const named = {
      coverEmployeeId: input.arrivingId,
      coverShiftId: coverShift.id,
      shuffleEmployeeId: null,
      shuffleShiftId: null,
      auto: false,
    };
    if (row.status === "booked") {
      await tx.staffBreak.update({ where: { id: row.id }, data: named });
      continue;
    }
    const wrote = await tx.staffBreak.updateMany({
      where: { id: row.id, status: "pending" },
      data: named,
    });
    if (wrote.count !== 1) continue;
    const outcome = await handedBooking(tx, {
      board: input.board,
      date: input.date,
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      startAt: row.startAt,
      endAt: row.endAt,
      coverEmployeeId: input.arrivingId,
      ignoreOverlayId: input.ignoreOverlayId,
      shifts: input.shifts,
    });
    if (outcome === "book") {
      await tx.staffBreak.updateMany({
        where: { id: row.id, status: "pending", coverEmployeeId: input.arrivingId },
        data: { status: "booked" },
      });
      continue;
    }
    if (outcome !== "roll") continue;
    const nextStart = new Date(row.startAt.getTime() + QUARTER_MS);
    const nextEnd = new Date(row.endAt.getTime() + QUARTER_MS);
    const rolled = assessBreak({
      date: input.date,
      startAt: nextStart,
      endAt: nextEnd,
      shifts: input.shifts.filter((shift) => shift.employeeId === row.employeeId),
      otherBreaks: await liveOtherBreaks(tx, input.date, row.employeeId),
    });
    if ("code" in rolled && rolled.code !== "CEILING") continue;
    const nextCover = coveringShift(input.shifts, input.arrivingId, nextStart, nextEnd, input.board);
    const keep = nextCover != null && await starAcceptsNamedCover(tx, {
      board: input.board,
      date: input.date,
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      startAt: nextStart,
      endAt: nextEnd,
      coverEmployeeId: input.arrivingId,
      ignoreOverlayId: input.ignoreOverlayId,
      shifts: input.shifts,
    });
    await tx.staffBreak.updateMany({
      where: { id: row.id, status: "pending", coverEmployeeId: input.arrivingId },
      data: {
        startAt: nextStart,
        endAt: nextEnd,
        ...(keep && nextCover
          ? { coverShiftId: nextCover.id }
          : {
            coverEmployeeId: null,
            coverShiftId: null,
            shuffleEmployeeId: null,
            shuffleShiftId: null,
          }),
      },
    });
  }
}

export async function saveOverlay(input: {
  manager: Manager;
  board: "caja" | "cocina";
  date: string;
  kind: OverlayKind;
  employeeId: string;
  partnerEmployeeId?: string | null;
  stationId?: string | null;
  window: OverlayWindowMode;
  startAt?: Date | null;
  endAt?: Date | null;
  now?: Date;
}): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  if (input.date !== chicagoToday(now)) throw new OverlayRefused("NOT_TODAY");
  return withStaffBreakLock(async (tx) => {
    const shifts = await tx.shift.findMany({
      where: { date: input.date, supersededAt: null, boardRemoved: false },
    });
    const holder = shifts.find((shift) => shift.employeeId === input.employeeId && shift.board === input.board);
    if (!holder) throw new OverlayRefused("WINDOW");
    const window = resolveOverlayWindow({
      mode: input.window,
      date: input.date,
      shiftStart: holder.startAt,
      shiftEnd: holder.endAt,
      now,
      quarterStart: input.startAt,
      quarterEnd: input.endAt,
    });
    if (!window) throw new OverlayRefused("WINDOW");
    if (!coveringShift(shifts, input.employeeId, window.startAt, window.endAt, input.board)) {
      throw new OverlayRefused("WINDOW");
    }
    const paints: SlicePaint[] = await decisionPaints(tx, input.date);
    const marks = await tx.mandatoryMark.findMany({
      where: { board: input.board, date: input.date },
      select: { stationId: true },
    });
    const stars = new Set([
      ...MANDATORY_STATIONS_BY_BOARD[input.board],
      ...marks.map((mark) => mark.stationId).filter((id) => !isDefaultMandatory(id)),
    ]);
    const overlays = screenOverlays(await loadOverlayRecords(tx, input.board, input.date), now);
    const day = buildDaySlices({
      date: input.date,
      board: input.board,
      now,
      stations: [...stars].map((id) => ({ id })),
      starStationIds: [...stars],
      shifts: shifts.map(asSliceShift),
      paints,
      breaks: [],
      overlays,
    });
    const mine = heldStation(day, input.employeeId, window.startAt, window.endAt);
    let partnerId: string | null = null;
    let stationId = input.stationId ?? "";
    let fromStationId: string | null = null;

    if (input.kind === "remove") {
      if (!mine) throw new OverlayRefused("NO_SEAT");
      stationId = mine;
    } else if (input.kind === "switch") {
      partnerId = input.partnerEmployeeId ?? "";
      if (!partnerId || partnerId === input.employeeId) throw new OverlayRefused("NOT_FOUND");
      if (!mine) throw new OverlayRefused("NO_SEAT");
      if (!coveringShift(shifts, partnerId, window.startAt, window.endAt, input.board)) {
        throw new OverlayRefused("WINDOW");
      }
      const theirs = heldStation(day, partnerId, window.startAt, window.endAt);
      if (!theirs) throw new OverlayRefused("NO_SEAT");
      if (stars.has(theirs)) throw new OverlayRefused("STAR_OTHER");
      if (!await canDoSeat(tx, input.employeeId, theirs) || !await canDoSeat(tx, partnerId, mine)) {
        throw new OverlayRefused("UNFIT");
      }
      stationId = theirs;
      fromStationId = mine;
    } else {
      partnerId = input.employeeId;
      if (!stationId) throw new OverlayRefused("NO_SEAT");
      if (!await canDoSeat(tx, input.employeeId, stationId)) throw new OverlayRefused("UNFIT");
      if (stationTaken(day, stationId, input.employeeId, window.startAt, window.endAt)) {
        throw new OverlayRefused("OCCUPIED");
      }
    }

    const created = await tx.boardOverlay.create({
      data: {
        date: input.date,
        board: input.board,
        kind: input.kind,
        employeeId: input.employeeId,
        partnerEmployeeId: partnerId,
        stationId,
        fromStationId,
        startAt: window.startAt,
        endAt: window.endAt,
        managerId: input.manager.id,
        managerName: input.manager.name,
      },
    });
    if (input.kind === "switch" && fromStationId) {
      await handStar(tx, {
        board: input.board,
        date: input.date,
        stationId,
        arrivingId: input.employeeId,
        start: window.startAt,
        end: window.endAt,
        shifts,
        stars,
        ignoreOverlayId: created.id,
      });
      await handStar(tx, {
        board: input.board,
        date: input.date,
        stationId: fromStationId,
        arrivingId: partnerId!,
        start: window.startAt,
        end: window.endAt,
        shifts,
        stars,
        ignoreOverlayId: created.id,
      });
    }
    if (input.kind === "add") {
      await handStar(tx, {
        board: input.board,
        date: input.date,
        stationId,
        arrivingId: input.employeeId,
        start: window.startAt,
        end: window.endAt,
        shifts,
        stars,
        ignoreOverlayId: created.id,
      });
    }
    await logOverlay(tx, input.manager, BOARD_CHANGE_ROUTES.overlaySave, {
      date: input.date,
      board: input.board,
      kind: input.kind,
      employeeId: input.employeeId,
      startAt: window.startAt,
      endAt: window.endAt,
    });
    return { id: created.id };
  });
}

export async function cancelOverlay(input: {
  manager: Manager;
  board: "caja" | "cocina";
  date: string;
  id: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  if (input.date !== chicagoToday(now)) throw new OverlayRefused("NOT_TODAY");
  await withStaffBreakLock(async (tx) => {
    const row = await tx.boardOverlay.findFirst({
      where: { id: input.id, board: input.board, date: input.date, cancelledAt: null },
    });
    if (!row || (row.kind !== "switch" && row.kind !== "remove" && row.kind !== "add")) {
      throw new OverlayRefused("NOT_FOUND");
    }
    await tx.boardOverlay.update({
      where: { id: row.id },
      data: { cancelledAt: now, endReason: "cancel" },
    });
    await logOverlay(tx, input.manager, BOARD_CHANGE_ROUTES.overlayCancel, {
      date: row.date,
      board: row.board,
      kind: row.kind,
      employeeId: row.employeeId,
      startAt: row.startAt,
      endAt: row.endAt,
    }, "cancel");
  });
}

/** Superseded and board-removed shifts end their overlays. The row stays. */
export async function endImportedOverlays(
  tx: Prisma.TransactionClient,
  input: {
    supersededShiftIds: readonly string[];
    boardRemovedShiftIds: readonly string[];
    now?: Date;
  },
): Promise<number> {
  const dead = [...new Set([...input.supersededShiftIds, ...input.boardRemovedShiftIds])];
  if (dead.length === 0) return 0;
  const shifts = await tx.shift.findMany({
    where: { id: { in: dead } },
    select: { employeeId: true, date: true },
  });
  const pairs = new Map<string, { employeeId: string; date: string }>();
  for (const shift of shifts) pairs.set(`${shift.employeeId}\0${shift.date}`, shift);
  const now = input.now ?? new Date();
  let ended = 0;
  for (const { employeeId, date } of pairs.values()) {
    const rows = await tx.boardOverlay.findMany({
      where: {
        date,
        cancelledAt: null,
        OR: [{ employeeId }, { partnerEmployeeId: employeeId }],
      },
    });
    for (const row of rows) {
      if (row.kind !== "switch" && row.kind !== "remove" && row.kind !== "add") continue;
      await tx.boardOverlay.update({
        where: { id: row.id },
        data: { cancelledAt: now, endReason: "import" },
      });
      await logOverlay(tx, IMPORT_ACTOR, BOARD_CHANGE_ROUTES.overlayImport, {
        date: row.date,
        board: row.board,
        kind: row.kind,
        employeeId: row.employeeId,
        startAt: row.startAt,
        endAt: row.endAt,
      }, "import");
      ended += 1;
    }
  }
  return ended;
}
