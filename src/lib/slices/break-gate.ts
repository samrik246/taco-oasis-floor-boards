import {
  buildDaySlices,
  sliceIndexesTouching,
  type SliceBoard,
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
