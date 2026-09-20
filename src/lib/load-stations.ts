/**
 * Cashiers order-load stations ↔ color-board seats (Phase 1 alignment).
 * Kitchen load stations are out of scope until cashiers phase is done.
 */

export const LOAD_STATION_IDS = ["nieves", "cliente", "carro", "expo"] as const;
export type LoadStationId = (typeof LOAD_STATION_IDS)[number];

export const BUSYNESS_LEVELS = ["quiet", "busy", "slammed"] as const;
export type BusynessLevel = (typeof BUSYNESS_LEVELS)[number];

export type LoadStationDef = {
  id: LoadStationId;
  label: string;
  /** Color-board seat station ids that carry this load */
  seatIds: readonly string[];
};

/** Locked map: cliente↔greens, carro↔yellow+blue, Expo↔purples, Nieves↔nieves */
export const CASHIER_LOAD_STATIONS: readonly LoadStationDef[] = [
  { id: "nieves", label: "Nieves", seatIds: ["nieves"] },
  { id: "cliente", label: "Cliente", seatIds: ["green1", "green2"] },
  { id: "carro", label: "Carro", seatIds: ["yellow", "blue"] },
  { id: "expo", label: "Expo", seatIds: ["purple1", "purple2"] },
] as const;

export function loadStationById(id: string): LoadStationDef | undefined {
  return CASHIER_LOAD_STATIONS.find((s) => s.id === id);
}

/** Seat → load station (first match). MULTI is not a primary load seat. */
export function loadStationForSeat(seatId: string): LoadStationDef | undefined {
  return CASHIER_LOAD_STATIONS.find((s) => s.seatIds.includes(seatId));
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
