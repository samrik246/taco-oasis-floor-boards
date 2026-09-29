import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";
import { hourSliceIndexes, sliceStart, type SliceBoard, type SlicePaint, type SliceShift } from "@/lib/slices/day-slices";

function shiftCoversSlice(shift: SliceShift, start: Date, end: Date): boolean {
  if (shift.superseded || shift.boardRemoved) return false;
  return start.getTime() >= shift.startAt.getTime() && end.getTime() <= shift.endAt.getTime();
}

/**
 * Painted hours divided by on-shift hours for this board.
 * An hour is on shift when the shift covers at least one whole quarter.
 * At 90% and above, on this date only, every empty on-shift hour is marked.
 */
export function amberEmptyShiftHours(input: {
  date: string;
  today: string;
  board: SliceBoard;
  shifts: readonly SliceShift[];
  paints: readonly SlicePaint[];
}): Map<string, number[]> {
  const empty = new Map<string, number[]>();
  if (input.date !== input.today) return empty;
  let onShift = 0;
  let painted = 0;
  const holes: { shiftId: string; hour: number }[] = [];
  for (const shift of input.shifts) {
    if (shift.superseded || shift.boardRemoved || shift.board !== input.board) continue;
    for (let hour = HOUR_GRID_START; hour < HOUR_GRID_END; hour += 1) {
      const covered = hourSliceIndexes(hour).some((index) => {
        const start = sliceStart(input.date, index);
        const end = sliceStart(input.date, index + 1);
        return shiftCoversSlice(shift, start, end);
      });
      if (!covered) continue;
      onShift += 1;
      const hasPaint = input.paints.some((paint) => {
        return paint.shiftId === shift.id && paint.hourStart.getTime() === sliceStart(input.date, hourSliceIndexes(hour)[0]!).getTime();
      });
      if (hasPaint) painted += 1;
      else holes.push({ shiftId: shift.id, hour });
    }
  }
  if (onShift === 0 || painted * 10 < onShift * 9) return empty;
  for (const hole of holes) {
    const hours = empty.get(hole.shiftId) ?? [];
    hours.push(hole.hour);
    empty.set(hole.shiftId, hours);
  }
  return empty;
}
