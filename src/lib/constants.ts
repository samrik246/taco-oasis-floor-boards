/** Venue defaults from SPEC §14 / §8 */
export const TIMEZONE = "America/Chicago";

/** Hour grid: inclusive start hour 7, exclusive end hour 22 → buckets 7..21 */
export const HOUR_GRID_START = 7;
export const HOUR_GRID_END = 22;

export const BOARD_LABELS = {
  caja: "Cashiers",
  cocina: "Kitchen",
  other: "Other",
} as const;

export type BoardKind = "caja" | "cocina" | "other";

/** Pay columns stripped on import — never persist (SPEC §3 / §6) */
export const PAY_COLUMNS = [
  "Hourly Rate",
  "Labor Cost",
  "Total",
] as const;

export const SCHEDULES_SHEET_NAME = "Schedules - Restaurant";
export const HOURLY_SHEET_NAME = "Hourly - Restaurant";
