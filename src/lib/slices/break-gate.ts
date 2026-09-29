import { chicagoHourOf } from "@/lib/hour-grid";
import { MANDATORY_GAP_START } from "@/lib/mandatory";
import {
  buildDaySlices,
  sliceIndexesTouching,
  type SliceBoard,
  type SliceBreak,
  type SlicePaint,
  type SliceShift,
} from "@/lib/slices/day-slices";

/**
 * The slices a break window touches, read inside the break lock.
 * assessBreak still decides. A success whose grid slices are outside the
 * shift is refused with the existing outside-shift code.
 */
export function readBreakGate(input: {
  date: string;
  employeeId: string;
  startAt: Date;
  endAt: Date;
  shifts: readonly SliceShift[];
}): { sliceIndexes: number[]; everyTouchedSliceInsideShift: boolean } {
  const held = input.shifts.find((shift) => {
    return shift.employeeId === input.employeeId
      && !shift.superseded
      && !shift.boardRemoved
      && (shift.board === "caja" || shift.board === "cocina")
      && input.startAt.getTime() >= shift.startAt.getTime()
      && input.endAt.getTime() <= shift.endAt.getTime();
  });
  const board: SliceBoard = held?.board === "caja" ? "caja" : "cocina";
  const day = buildDaySlices({
    date: input.date,
    board,
    now: input.startAt,
    stations: [],
    starStationIds: [],
    shifts: input.shifts,
    paints: [],
    breaks: [],
    overlays: [],
  });
  const sliceIndexes = sliceIndexesTouching(day, input.startAt, input.endAt);
  const everyTouchedSliceInsideShift = sliceIndexes.every((index) => {
    const person = day.slices[index]?.people.find((row) => row.employeeId === input.employeeId);
    return person != null && person.cell !== "absent";
  });
  return { sliceIndexes, everyTouchedSliceInsideShift };
}

export type StarGateCode = "EMPTY_STAR" | "STAR_COUNT" | "NEEDS_COVER" | "BAD_COVER";

export type StarGateDecision =
  | {
    status: "booked";
    coverEmployeeId: string | null;
    coverShiftId: string | null;
    shuffleEmployeeId: string | null;
    shuffleShiftId: string | null;
  }
  | { code: StarGateCode };

function bookedCover(
  coverEmployeeId: string | null,
  coverShiftId: string | null,
  shuffleEmployeeId: string | null = null,
  shuffleShiftId: string | null = null,
): StarGateDecision {
  return { status: "booked", coverEmployeeId, coverShiftId, shuffleEmployeeId, shuffleShiftId };
}

function windowHolds(shift: SliceShift, start: Date, end: Date): boolean {
  return !shift.superseded
    && !shift.boardRemoved
    && start.getTime() >= shift.startAt.getTime()
    && end.getTime() <= shift.endAt.getTime();
}

/**
 * Star rules from 11:00 only. An empty star on a touched slice refuses the
 * break. A person sitting a star waits until a cover is named. The cover
 * must be free for the whole window and must not sit another star.
 * A Shuffle names that star person plus the free person who takes their seat.
 */
export function assessStarGate(input: {
  date: string;
  board: SliceBoard;
  employeeId: string;
  startAt: Date;
  endAt: Date;
  shifts: readonly SliceShift[];
  paints: readonly SlicePaint[];
  breaks: readonly SliceBreak[];
  starStationIds: readonly string[];
  coverEmployeeId?: string | null;
  shuffleEmployeeId?: string | null;
}): StarGateDecision {
  const stars = new Set(input.starStationIds);
  const resting = input.breaks.filter((row) => row.employeeId !== input.employeeId);
  const base = {
    date: input.date,
    board: input.board,
    now: input.startAt,
    stations: input.starStationIds.map((id) => ({ id })),
    starStationIds: input.starStationIds,
    shifts: input.shifts,
    paints: input.paints,
    overlays: [],
  };
  const today = buildDaySlices({ ...base, breaks: resting });
  const indexes = sliceIndexesTouching(today, input.startAt, input.endAt);
  const starred = indexes
    .map((index) => today.slices[index])
    .filter((slice) => slice != null && chicagoHourOf(slice.start) >= MANDATORY_GAP_START);
  if (starred.length === 0) return bookedCover(null, null);
  if (starred.some((slice) => slice.emptyStarStationIds.length > 0)) {
    return { code: "EMPTY_STAR" };
  }

  const askerInStar = starred.some((slice) => {
    const person = slice.people.find((row) => row.employeeId === input.employeeId);
    return person?.stationId != null && stars.has(person.stationId);
  });
  const coverId = input.coverEmployeeId ?? null;
  if (askerInStar && !coverId) return { code: "NEEDS_COVER" };

  let coverShiftId: string | null = null;
  let shuffleId: string | null = null;
  let shuffleShiftId: string | null = null;
  if (coverId) {
    if (coverId === input.employeeId) return { code: "BAD_COVER" };
    const coverShift = input.shifts.find((shift) => {
      return shift.employeeId === coverId && windowHolds(shift, input.startAt, input.endAt);
    });
    if (!coverShift) return { code: "BAD_COVER" };
    coverShiftId = coverShift.id;
    const coverOnBreak = starred.some((slice) => {
      return slice.people.find((row) => row.employeeId === coverId)?.onBreak === true;
    });
    if (coverOnBreak) return { code: "BAD_COVER" };
    const coverOnStar = starred.some((slice) => {
      const stationId = slice.people.find((row) => row.employeeId === coverId)?.stationId;
      return stationId != null && stars.has(stationId);
    });
    const requestedShuffle = input.shuffleEmployeeId ?? null;
    if (coverOnStar) {
      if (!requestedShuffle || requestedShuffle === coverId || requestedShuffle === input.employeeId) {
        return { code: "BAD_COVER" };
      }
      const shuffleShift = input.shifts.find((shift) => {
        return shift.employeeId === requestedShuffle && windowHolds(shift, input.startAt, input.endAt);
      });
      if (!shuffleShift) return { code: "BAD_COVER" };
      const shuffleBlocked = starred.some((slice) => {
        const partner = slice.people.find((row) => row.employeeId === requestedShuffle);
        if (partner?.onBreak) return true;
        return partner?.stationId != null && stars.has(partner.stationId);
      });
      if (shuffleBlocked) return { code: "BAD_COVER" };
      shuffleId = requestedShuffle;
      shuffleShiftId = shuffleShift.id;
    } else if (requestedShuffle) {
      return { code: "BAD_COVER" };
    }
  }

  const proposed: SliceBreak = {
    employeeId: input.employeeId,
    shiftId: "proposed",
    board: input.board,
    startAt: input.startAt,
    endAt: input.endAt,
    status: "booked",
    coverEmployeeId: coverId,
    shuffleEmployeeId: shuffleId,
  };
  const after = buildDaySlices({ ...base, breaks: [...resting, proposed] });
  for (const index of indexes) {
    const slice = after.slices[index];
    if (!slice || chicagoHourOf(slice.start) < MANDATORY_GAP_START) continue;
    if (slice.emptyStarStationIds.length > 0) return { code: "EMPTY_STAR" };
    if (slice.presentNotOnBreak < after.starCount) return { code: "STAR_COUNT" };
  }
  return bookedCover(coverId, coverShiftId, shuffleId, shuffleShiftId);
}
