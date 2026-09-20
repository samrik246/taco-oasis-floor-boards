/**
 * Order-load stations ↔ seat map per board.
 * Cashiers: 4 load stations. Kitchen: 6 (1:1 with seats).
 */

export const BUSYNESS_LEVELS = ["quiet", "busy", "slammed"] as const;
export type BusynessLevel = (typeof BUSYNESS_LEVELS)[number];

export type LoadStationDef = {
  id: string;
  label: string;
  /** Color-board seat station ids that carry this load */
  seatIds: readonly string[];
};

export const CASHIER_LOAD_STATION_IDS = [
  "nieves",
  "cliente",
  "carro",
  "expo",
] as const;
export type CashierLoadStationId = (typeof CASHIER_LOAD_STATION_IDS)[number];

export const KITCHEN_LOAD_STATION_IDS = [
  "fryer",
  "tortilla",
  "birria",
  "taquero",
  "carne",
  "prepa",
] as const;
export type KitchenLoadStationId = (typeof KITCHEN_LOAD_STATION_IDS)[number];

export type LoadStationId = CashierLoadStationId | KitchenLoadStationId;

/** Locked map: cliente↔greens, carro↔yellow+blue, Expo↔purples, Nieves↔nieves */
export const CASHIER_LOAD_STATIONS: readonly LoadStationDef[] = [
  { id: "nieves", label: "Nieves", seatIds: ["nieves"] },
  { id: "cliente", label: "Cliente", seatIds: ["green1", "green2"] },
  { id: "carro", label: "Carro", seatIds: ["yellow", "blue"] },
  { id: "expo", label: "Expo", seatIds: ["purple1", "purple2"] },
] as const;

/** Kitchen load = seat 1:1 for the six cocina stations */
export const KITCHEN_LOAD_STATIONS: readonly LoadStationDef[] = [
  { id: "fryer", label: "Fryer", seatIds: ["fryer"] },
  { id: "tortilla", label: "Tortilla", seatIds: ["tortilla"] },
  { id: "birria", label: "Birria", seatIds: ["birria"] },
  { id: "taquero", label: "Taquero", seatIds: ["taquero"] },
  { id: "carne", label: "Carne", seatIds: ["carne"] },
  { id: "prepa", label: "Prepa", seatIds: ["prepa"] },
] as const;

/** @deprecated Prefer board-scoped helpers; kept for Cashiers Phase 1 imports */
export const LOAD_STATION_IDS = CASHIER_LOAD_STATION_IDS;

export function allLoadStationDefs(): readonly LoadStationDef[] {
  return [...CASHIER_LOAD_STATIONS, ...KITCHEN_LOAD_STATIONS];
}

export function loadStationById(id: string): LoadStationDef | undefined {
  return allLoadStationDefs().find((s) => s.id === id);
}

/** Seat → load station (first match). MULTI is not a primary load seat. */
export function loadStationForSeat(seatId: string): LoadStationDef | undefined {
  return allLoadStationDefs().find((s) => s.seatIds.includes(seatId));
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

export function isCashierLoadStationId(id: string): id is CashierLoadStationId {
  return (CASHIER_LOAD_STATION_IDS as readonly string[]).includes(id);
}

export function isKitchenLoadStationId(id: string): id is KitchenLoadStationId {
  return (KITCHEN_LOAD_STATION_IDS as readonly string[]).includes(id);
}
