import type { BoardKind } from "./constants";

/**
 * Route a When I Work Position string to a floor board (SPEC §3).
 *
 * DECISION: Cocina board = Position contains "Cocina" (case-insensitive).
 * `Produccion` and `Picar Carne` are imported as `other` so bucket counts match
 * SPEC §10 acceptance (~109 / ~105 / ~19). Kitchen phase seats are
 * fryer/tortilla/birria/taquero/carne/prepa — position hints map onto those.
 */
export function routePositionToBoard(position: string): BoardKind {
  const p = position.trim();
  const lower = p.toLowerCase();

  if (lower.includes("caja")) {
    return "caja";
  }

  if (lower.includes("cocina")) {
    return "cocina";
  }

  // Explicit cocina-related titles listed in SPEC §3 examples, but treated as
  // other for floor-board hide-by-default until mapping UI exists (see DECISIONS).
  if (lower === "produccion" || lower === "picar carne") {
    return "other";
  }

  return "other";
}

/** Hint station id from schedule Position (SPEC §4.3 / §10 + Kitchen phase) */
export function positionStationHint(position: string): string | null {
  const lower = position.trim().toLowerCase();
  if (lower === "caja manager") return "mana";
  if (lower.includes("nieves")) return "nieves";
  if (lower.includes("meser")) return "mesero";
  if (lower.includes("limpieza")) return "clean";
  if (lower.includes("prueba")) return "green1";
  if (lower.includes("fryer") || lower.includes("freidor")) return "fryer";
  if (lower.includes("tortilla")) return "tortilla";
  if (lower.includes("birria")) return "birria";
  if (lower.includes("taquero")) return "taquero";
  if (lower === "produccion" || lower.includes("carne") || lower.includes("picar"))
    return "carne";
  if (lower.includes("prepa") || lower.includes("prep")) return "prepa";
  if (lower.includes("cocina")) return "taquero";
  if (lower.includes("caja")) return null;
  return null;
}
