import { isDefaultMandatory } from "@/lib/mandatory";
import { addDays } from "@/lib/upcoming/calendar";

/** Saved assignments in this many calendar days before the day on screen. */
export const PALETTE_USE_DAYS = 28;

/**
 * First day of the use window. The day on screen is not included, so a draft
 * or a save on that day cannot move a palette button.
 */
export function paletteUseStart(date: string): string {
  return addDays(date, -PALETTE_USE_DAYS);
}

/**
 * Palette ids, top to bottom.
 * Default-mandatory stations first, in board order (`sortOrder`, then id).
 * Today's extra marks next, in that same board order.
 * Every other station follows, most-used first. Equal counts stay in board order.
 * Counts are saved rows only. This function does not read a paint draft.
 */
export function paletteStationIds(input: {
  stations: readonly { id: string; sortOrder: number }[];
  stationUse?: readonly { stationId: string; count: number }[];
  extraStationIds?: readonly string[];
}): string[] {
  const boardOrder = [...input.stations].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
  const rank = new Map(boardOrder.map((station, index) => [station.id, index]));
  const byBoard = (a: string, b: string) => rank.get(a)! - rank.get(b)!;
  const counts = new Map((input.stationUse ?? []).map((row) => [row.stationId, row.count]));
  const defaults = boardOrder.filter((station) => isDefaultMandatory(station.id)).map((station) => station.id);
  const leading = new Set(defaults);
  const extras = [...new Set(input.extraStationIds ?? [])]
    .filter((id) => rank.has(id) && !leading.has(id))
    .sort(byBoard);
  for (const id of extras) leading.add(id);
  const rest = boardOrder
    .map((station) => station.id)
    .filter((id) => !leading.has(id))
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || byBoard(a, b));
  return [...defaults, ...extras, ...rest];
}
