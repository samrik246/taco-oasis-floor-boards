/**
 * Order-load stations ↔ color-board seats.
 * Shared template: each board owns its load map via board-config.
 */

export const BUSYNESS_LEVELS = ["quiet", "busy", "slammed"] as const;
export type BusynessLevel = (typeof BUSYNESS_LEVELS)[number];

export type LoadStationDef = {
  id: string;
  label: string;
  /** Color-board seat station ids that carry this load */
  seatIds: readonly string[];
  /** Owning floor board */
  board: "caja" | "cocina";
};

/** Locked caja map: cliente↔greens, carro↔yellow+blue, Expo↔purples, Nieves↔nieves */
export const CASHIER_LOAD_STATIONS: readonly LoadStationDef[] = [
  { id: "nieves", label: "Nieves", seatIds: ["nieves", "nieves2"], board: "caja" },
  { id: "cliente", label: "Cliente", seatIds: ["green1", "green2"], board: "caja" },
  { id: "carro", label: "Carro", seatIds: ["yellow", "yellow2", "blue"], board: "caja" },
  { id: "expo", label: "Expo", seatIds: ["purple1", "purple2"], board: "caja" },
] as const;

/** Kitchen load categories point to the retained numbered board seats. */
export const KITCHEN_LOAD_STATIONS: readonly LoadStationDef[] = [
  { id: "fryer", label: "Fryer", seatIds: ["pdf_tf1r", "pdf_tf2r"], board: "cocina" },
  { id: "tortilla", label: "Tortilla", seatIds: ["pdf_tf1r", "pdf_tf2r"], board: "cocina" },
  { id: "birria", label: "Birria", seatIds: ["pdf_br1a", "pdf_br2a"], board: "cocina" },
  { id: "taquero", label: "Taquero", seatIds: ["pdf_tq1r", "pdf_tq2r", "pdf_tq3r"], board: "cocina" },
  { id: "carne", label: "Carne", seatIds: ["pdf_crne"], board: "cocina" },
  { id: "prepa", label: "Prepa", seatIds: ["pdf_pr1e", "pdf_pr2e", "pdf_pr3e"], board: "cocina" },
] as const;

/** @deprecated Prefer LoadStationDef.id — kept for cashiers Phase 1 type aliases */
export const LOAD_STATION_IDS = ["nieves", "cliente", "carro", "expo"] as const;
export type LoadStationId = string;

export function loadStationsForBoard(
  board: "caja" | "cocina",
): readonly LoadStationDef[] {
  return board === "caja" ? CASHIER_LOAD_STATIONS : KITCHEN_LOAD_STATIONS;
}

export function allLoadStationDefs(): readonly LoadStationDef[] {
  return [...CASHIER_LOAD_STATIONS, ...KITCHEN_LOAD_STATIONS];
}

export function loadStationById(id: string): LoadStationDef | undefined {
  return allLoadStationDefs().find((s) => s.id === id);
}

/** Seat → load station (first match across boards). */
export function loadStationForSeat(seatId: string): LoadStationDef | undefined {
  return allLoadStationDefs().find((s) => s.seatIds.includes(seatId));
}

/** Combined-duty seats can belong to more than one load category. */
export function loadStationsForSeat(seatId: string): LoadStationDef[] {
  return allLoadStationDefs().filter((s) => s.seatIds.includes(seatId));
}

export function isValidBusyness(level: string): level is BusynessLevel {
  return (BUSYNESS_LEVELS as readonly string[]).includes(level);
}

/** Score thresholds used by the fake order simulator (orders in last window). */
export function busynessFromOrderCount(count: number): BusynessLevel {
  if (count >= 8) return "slammed";
  if (count >= 4) return "busy";
  return "quiet";
}
