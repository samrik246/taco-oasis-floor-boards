/**
 * Station uniqueness hard rule (SPEC §4.2 + Phase 1):
 * At most one employee per (board, date, hour, stationId) when maxConcurrent=1.
 * Stations with maxConcurrent < 0 remain unlimited (legacy helper; Nieves is now 1).
 * Stations with maxConcurrent > 1 (e.g. cocina linea=2) allow that many.
 */
export function canOccupyStation(args: {
  maxConcurrent: number;
  existingOccupancy: number;
  /** When updating an existing assignment on this station/hour, exclude it from the count */
  reservingSlot?: boolean;
}): boolean {
  const { maxConcurrent, existingOccupancy, reservingSlot = false } = args;
  if (maxConcurrent < 0) return true; // unlimited (unused for caja after Phase 1)
  const effective = reservingSlot
    ? Math.max(0, existingOccupancy - 1)
    : existingOccupancy;
  return effective < maxConcurrent;
}

/** True when the station allows stacking (maxConcurrent < 0). Nieves no longer stacks. */
export function isStackableStation(maxConcurrent: number): boolean {
  return maxConcurrent < 0;
}
