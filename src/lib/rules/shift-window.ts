/**
 * Shift window hard rule (SPEC §4.1):
 * Allowed iff shiftStart <= hourStart < shiftEnd (inclusive start, exclusive end).
 */
export function isHourInShift(
  hourStart: Date,
  shiftStart: Date,
  shiftEnd: Date,
): boolean {
  const h = hourStart.getTime();
  return h >= shiftStart.getTime() && h < shiftEnd.getTime();
}
