/**
 * Shift window hard rule. C1 supersedes SPEC §4.1 for partial hours:
 * a grid hour is on-shift when [hourStart, hourEnd) overlaps
 * [shiftStart, shiftEnd) by at least one minute. Both intervals are half-open,
 * so a shift ending exactly at hourStart (back-to-back) does not overlap.
 * Assignment, both grids, Rush coverage, the people list and the ledger all
 * use these two functions.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Whole minutes of [hourStart, hourEnd) inside [shiftStart, shiftEnd). */
export function shiftOverlapMinutes(
  hourStart: Date,
  hourEnd: Date,
  shiftStart: Date,
  shiftEnd: Date,
): number {
  const from = Math.max(hourStart.getTime(), shiftStart.getTime());
  const to = Math.min(hourEnd.getTime(), shiftEnd.getTime());
  return to > from ? Math.floor((to - from) / MINUTE_MS) : 0;
}

/** On-shift iff the hour overlaps the shift by at least one minute. */
export function isHourInShift(
  hourStart: Date,
  shiftStart: Date,
  shiftEnd: Date,
  hourEnd: Date = new Date(hourStart.getTime() + HOUR_MS),
): boolean {
  return shiftOverlapMinutes(hourStart, hourEnd, shiftStart, shiftEnd) >= 1;
}
