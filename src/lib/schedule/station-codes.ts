/**
 * Short position codes for schedule-grid blocks (cocina colores style).
 * Keys match existing station ids — no parallel station system.
 */

export const STATION_SHORT_CODES: Record<string, string> = {
  mana: "MANAGER",
  green1: "G1",
  yellow: "YEL",
  yellow2: "YEL2",
  purple1: "P1",
  green2: "G2",
  blue: "BLU",
  purple2: "P2",
  multi: "MULTI",
  nieves: "NIE1",
  nieves2: "NIE2",
  mesero: "MES",
  clean: "LIMPIEZA",
  pdf_guia: "GUIA",
  pdf_pr1e: "PR1E",
  pdf_pr2e: "PR2E",
  pdf_pr3e: "PR3E",
  pdf_tf1r: "TF1R",
  pdf_tf2r: "TF2R",
  pdf_tq1r: "TQ1R",
  pdf_tq2r: "TQ2R",
  pdf_tq3r: "TQ3R",
  pdf_br1a: "BR1A",
  pdf_br2a: "BR2A",
  pdf_crne: "CRNE",
  pdf_pstl: "PSTL",
  pdf_rlno: "RLNO",
  pdf_rngn: "RNGN",
  pdf_tsrea: "TSR1",
  pdf_tsr2: "TSR2",
  pdf_tsr3: "TSR3",
  pdf_tsr4: "TSR4",
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
