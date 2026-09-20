/**
 * Station uniqueness hard rule (SPEC §4.2):
 * At most one employee per (board, date, hour, stationId),
 * except stations with maxConcurrent < 0 (nieves = unlimited) or maxConcurrent > 1 (e.g. linea=2).
 */
export function canOccupyStation(args: {
  maxConcurrent: number;
  existingOccupancy: number;
  /** When updating an existing assignment on this station/hour, exclude it from the count */
  reservingSlot?: boolean;
}): boolean {
  const { maxConcurrent, existingOccupancy, reservingSlot = false } = args;
  if (maxConcurrent < 0) return true; // unlimited
  const effective = reservingSlot
    ? Math.max(0, existingOccupancy - 1)
    : existingOccupancy;
  return effective < maxConcurrent;
}

/** True when the station allows stacking (nieves-style unlimited). */
export function isStackableStation(maxConcurrent: number): boolean {
  return maxConcurrent < 0;
}
