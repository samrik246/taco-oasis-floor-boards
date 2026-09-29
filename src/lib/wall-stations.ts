/** Tiles for the wall at one Chicago hour. Empty seats and off-hours stay off the grid. */
export function wallTilesForHour<T extends { id: string }>(
  stations: readonly T[],
  occupiedIds: ReadonlySet<string>,
  onGrid: boolean,
): T[] {
  if (!onGrid) return [];
  return stations.filter((station) => occupiedIds.has(station.id));
}
