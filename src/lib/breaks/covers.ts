import { levelWhenUnset } from "@/lib/abilities/column-default";
import { chicagoHourOf } from "@/lib/hour-grid";
import { PAINT_FAMILIES, familyForStation } from "@/lib/assignments/paint-families";
import { isDefaultMandatory, MANDATORY_GAP_START } from "@/lib/mandatory";
import { abilitySortRank } from "@/lib/rules/abilities";
import { assessStarGate } from "@/lib/slices/break-gate";
import {
  buildDaySlices,
  sliceIndexesTouching,
  type SliceBoard,
  type SliceBreak,
  type SliceOverlay,
  type SlicePaint,
  type SliceShift,
} from "@/lib/slices/day-slices";

export type CoverMove = {
  employeeId: string;
  shiftId: string;
  firstName: string;
};

export type BreakCover =
  | { kind: "simple"; employeeId: string; shiftId: string; firstName: string }
  | { kind: "shuffle"; moves: [CoverMove, CoverMove] };

type AbilityRow = { employeeId: string; stationId: string; level: string };

type RankedSimple = { rank: number; employeeId: string; shiftId: string; firstName: string };
type RankedShuffle = { rank: number; partnerRank: number; moves: [CoverMove, CoverMove] };

/** Preferred, then ok, then training. A Shuffle of two is after the simple names. */
function rankCoverCandidates(input: {
  date: string;
  board: SliceBoard;
  employeeId: string;
  startAt: Date;
  endAt: Date;
  shifts: readonly SliceShift[];
  paints: readonly SlicePaint[];
  breaks: readonly SliceBreak[];
  overlays?: readonly SliceOverlay[];
  starStationIds: readonly string[];
  canonical?: boolean;
  abilities: readonly AbilityRow[];
  defaults?: ReadonlyMap<string, string>;
  names: ReadonlyMap<string, string>;
}): { simples: RankedSimple[]; shuffles: RankedShuffle[] } {
  const stars = new Set(input.starStationIds);
  const defaults = input.defaults ?? new Map<string, string>();
  const resting = input.breaks.filter((row) => row.employeeId !== input.employeeId);
  const day = buildDaySlices({
    date: input.date,
    board: input.board,
    now: input.startAt,
    stations: input.starStationIds.map((id) => ({ id })),
    starStationIds: input.starStationIds,
    shifts: input.shifts,
    paints: input.paints,
    breaks: resting,
    overlays: input.overlays ?? [],
  });
  const starred = sliceIndexesTouching(day, input.startAt, input.endAt)
    .map((index) => day.slices[index])
    .filter((slice) => slice != null && chicagoHourOf(slice.start) >= MANDATORY_GAP_START);
  const askerStations = [...new Set(starred.flatMap((slice) => {
    const stationId = slice.people.find((person) => person.employeeId === input.employeeId)?.stationId;
    return stationId != null && stars.has(stationId) ? [stationId] : [];
  }))];
  if (askerStations.length === 0 || starred.length === 0) return { simples: [], shuffles: [] };

  const held = new Map<string, SliceShift>();
  for (const shift of input.shifts) {
    if (shift.employeeId === input.employeeId || held.has(shift.employeeId)) continue;
    const cover = coveringShift(input.shifts, shift.employeeId, input.startAt, input.endAt, input.board);
    if (cover) held.set(shift.employeeId, cover);
  }

  const simples: { rank: number; employeeId: string; shiftId: string; firstName: string }[] = [];
  for (const [employeeId, shift] of held) {
    const firstName = input.names.get(employeeId);
    if (!firstName) continue;
    if (!isFree(starred, employeeId, stars)) continue;
    const rank = coverRank(employeeId, askerStations, input.abilities, defaults);
    if (rank == null) continue;
    simples.push({ rank, employeeId, shiftId: shift.id, firstName });
  }
  simples.sort((a, b) => a.rank - b.rank || a.firstName.localeCompare(b.firstName) || a.employeeId.localeCompare(b.employeeId));

  const shuffles: { rank: number; partnerRank: number; moves: [CoverMove, CoverMove] }[] = [];
  if (askerStations.length === 1) {
    for (const [moverId, moverShift] of held) {
      const moverName = input.names.get(moverId);
      if (!moverName) continue;
      const fromStation = starStationHeld(starred, moverId, stars);
      if (!fromStation || askerStations.includes(fromStation)) continue;
      const moverRank = coverRank(moverId, askerStations, input.abilities, defaults);
      if (moverRank == null) continue;
      for (const [partnerId, partnerShift] of held) {
        if (partnerId === moverId) continue;
        const partnerName = input.names.get(partnerId);
        if (!partnerName || !isFree(starred, partnerId, stars)) continue;
        const partnerRank = coverRank(partnerId, [fromStation], input.abilities, defaults);
        if (partnerRank == null) continue;
        shuffles.push({
          rank: moverRank,
          partnerRank,
          moves: [
            { employeeId: moverId, shiftId: moverShift.id, firstName: moverName },
            { employeeId: partnerId, shiftId: partnerShift.id, firstName: partnerName },
          ],
        });
      }
    }
  }
  shuffles.sort((a, b) => {
    return a.rank - b.rank
      || a.partnerRank - b.partnerRank
      || a.moves[0].firstName.localeCompare(b.moves[0].firstName)
      || a.moves[1].firstName.localeCompare(b.moves[1].firstName)
      || a.moves[0].employeeId.localeCompare(b.moves[0].employeeId);
  });

  return { simples, shuffles };
}

/**
 * Names only, best first. Simple covers (preferred, then ok, then training),
 * then a Shuffle of two moves. A longer chain is not a cover.
 * A missing ability is ok. Forbidden is left off the list.
 */
export function listBreakCovers(input: Parameters<typeof rankCoverCandidates>[0]): BreakCover[] {
  const ranked = rankCoverCandidates(input);
  const rows: BreakCover[] = [
    ...ranked.simples.map((row) => ({
      kind: "simple" as const,
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      firstName: row.firstName,
    })),
    ...ranked.shuffles.map((row) => ({ kind: "shuffle" as const, moves: row.moves })),
  ];
  return rows.filter((row) => acceptsCover(input, row));
}

/**
 * The first simple cover the five-minute pick may name.
 * Preferred, then ok. Training and a Shuffle stay off this list.
 */
export function firstAutoCover(
  input: Parameters<typeof rankCoverCandidates>[0],
): { employeeId: string; shiftId: string } | null {
  const okRank = abilitySortRank("ok");
  for (const row of rankCoverCandidates(input).simples) {
    if (row.rank > okRank) continue;
    const cover: BreakCover = {
      kind: "simple",
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      firstName: row.firstName,
    };
    if (!acceptsCover(input, cover)) continue;
    return { employeeId: row.employeeId, shiftId: row.shiftId };
  }
  return null;
}

export function listedCover(
  list: readonly BreakCover[],
  coverEmployeeId: string,
  shuffleEmployeeId: string | null,
): BreakCover | null {
  for (const row of list) {
    if (row.kind === "simple") {
      if (shuffleEmployeeId == null && row.employeeId === coverEmployeeId) return row;
      continue;
    }
    if (row.moves[0].employeeId === coverEmployeeId && row.moves[1].employeeId === shuffleEmployeeId) {
      return row;
    }
  }
  return null;
}

function acceptsCover(
  input: Parameters<typeof listBreakCovers>[0],
  row: BreakCover,
): boolean {
  const decision = assessStarGate({
    canonical:input.canonical,
    coverShiftId:row.kind==="simple"?row.shiftId:row.moves[0].shiftId,
    shuffleShiftId:row.kind==="shuffle"?row.moves[1].shiftId:null,
    date: input.date,
    board: input.board,
    employeeId: input.employeeId,
    startAt: input.startAt,
    endAt: input.endAt,
    shifts: input.shifts,
    paints: input.paints,
    breaks: input.breaks,
    starStationIds: input.starStationIds,
    overlays: input.overlays,
    coverEmployeeId: row.kind === "simple" ? row.employeeId : row.moves[0].employeeId,
    shuffleEmployeeId: row.kind === "shuffle" ? row.moves[1].employeeId : null,
  });
  return !("code" in decision);
}

function coveringShift(
  shifts: readonly SliceShift[],
  employeeId: string,
  start: Date,
  end: Date,
  board: string,
): SliceShift | null {
  const hits = shifts.filter((shift) => {
    return shift.employeeId === employeeId
      && !shift.superseded
      && !shift.boardRemoved
      && start.getTime() >= shift.startAt.getTime()
      && end.getTime() <= shift.endAt.getTime();
  });
  hits.sort((a, b) => {
    const boardRank = (shift: SliceShift) => shift.board === board ? 0 : 1;
    return boardRank(a) - boardRank(b) || a.id.localeCompare(b.id);
  });
  return hits[0] ?? null;
}

function isFree(
  slices: readonly { people: { employeeId: string; onBreak: boolean; stationId: string | null }[] }[],
  employeeId: string,
  stars: ReadonlySet<string>,
): boolean {
  return slices.every((slice) => {
    const person = slice.people.find((row) => row.employeeId === employeeId);
    if (!person) return true;
    if (person.onBreak) return false;
    return person.stationId == null || !stars.has(person.stationId);
  });
}

function starStationHeld(
  slices: readonly { people: { employeeId: string; stationId: string | null }[] }[],
  employeeId: string,
  stars: ReadonlySet<string>,
): string | null {
  let held: string | null = null;
  for (const slice of slices) {
    const stationId = slice.people.find((person) => person.employeeId === employeeId)?.stationId ?? null;
    if (stationId == null || !stars.has(stationId)) return null;
    if (held == null) held = stationId;
    else if (held !== stationId) return null;
  }
  return held;
}

function coverRank(
  employeeId: string,
  stationIds: readonly string[],
  abilities: readonly AbilityRow[],
  defaults: ReadonlyMap<string, string>,
): number | null {
  if (stationIds.length === 0) return null;
  let worst = 0;
  for (const stationId of stationIds) {
    const stored = abilities.find((row) => row.employeeId === employeeId && row.stationId === stationId)?.level;
    const level = levelWhenUnset(stored, defaults.get(stationId)) ?? "ok";
    if (level === "forbidden") return null;
    worst = Math.max(worst, abilitySortRank(level));
  }
  return worst;
}

/** Seat 2 only, on the same board for the entire window, using effective paint/overlays. */
export function numberedSeatCover(input: Parameters<typeof listBreakCovers>[0]): Extract<BreakCover, { kind: "simple" }> | null {
  const day = buildDaySlices({
    ...input, now: input.startAt, stations: input.starStationIds.map(id => ({ id })),
    breaks: input.breaks.filter(b => b.employeeId !== input.employeeId), overlays: input.overlays ?? [],
  });
  const slices = sliceIndexesTouching(day, input.startAt, input.endAt).map(i => day.slices[i]);
  if (!slices.length || slices.some(s => !s)) return null;
  const candidates = listBreakCovers(input).filter((c): c is Extract<BreakCover, { kind: "simple" }> => c.kind === "simple");
  for (const candidate of candidates) {
    const held = input.shifts.find(s => s.id === candidate.shiftId && s.board === input.board && !s.superseded && !s.boardRemoved
      && s.startAt <= input.startAt && s.endAt >= input.endAt);
    if (!held) continue;
    if (input.breaks.some(b => b.employeeId !== input.employeeId && b.status === "booked"
      && b.startAt < input.endAt && b.endAt > input.startAt
      && (b.employeeId === candidate.employeeId || b.coverEmployeeId === candidate.employeeId || b.shuffleEmployeeId === candidate.employeeId))) continue;
    const matches = slices.every(slice => {
      const asker = slice.people.find(p => p.employeeId === input.employeeId);
      const cover = slice.people.find(p => p.employeeId === candidate.employeeId);
      if (!asker?.stationId || !cover || cover.onBreak) return false;
      const family = familyForStation(asker.stationId);
      if (!family) return false;
      const pair = PAINT_FAMILIES[family];
      return isDefaultMandatory(pair[0]) && asker.stationId === pair[0] && cover.stationId === pair[1];
    });
    if (matches) return candidate;
  }
  return null;
}
