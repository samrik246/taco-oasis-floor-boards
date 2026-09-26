/**
 * Short position codes for schedule-grid blocks (cocina colores style).
 * Keys match existing station ids — no parallel station system.
 */

export const STATION_SHORT_CODES: Record<string, string> = {
  mana: "MANA",
  green1: "G1",
  yellow: "YEL",
  purple1: "P1",
  green2: "G2",
  blue: "BLU",
  purple2: "P2",
  multi: "MUL",
  nieves: "NIE",
  mesero: "MES",
  clean: "LIM",
  fryer: "FRY",
  tortilla: "TOR",
  birria: "BIR",
  taquero: "TAQ",
  carne: "CAR",
  prepa: "PRE",
};

export function stationShortCode(stationId: string): string {
  return STATION_SHORT_CODES[stationId] ?? stationId.slice(0, 3).toUpperCase();
}

/** Solid fills with readable contrast (spreadsheet-style). */
export function stationSolidClass(color: string): string {
  const map: Record<string, string> = {
    pink: "bg-pink-400 text-pink-950",
    green: "bg-green-500 text-white",
    yellow: "bg-yellow-400 text-yellow-950",
    purple: "bg-purple-500 text-white",
    lime: "bg-lime-400 text-lime-950",
    blue: "bg-blue-500 text-white",
    lavender: "bg-violet-400 text-violet-950",
    gray: "bg-neutral-400 text-neutral-950",
    teal: "bg-teal-500 text-white",
    orange: "bg-orange-500 text-white",
    cyan: "bg-cyan-400 text-cyan-950",
    red: "bg-red-500 text-white",
    brown: "bg-amber-600 text-white",
    maroon: "bg-[#8c1a11] text-white",
  };
  return map[color] ?? "bg-neutral-300 text-neutral-950";
}
