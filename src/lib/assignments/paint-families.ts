export const PAINT_FAMILIES = {
  green: ["green1", "green2"],
  purple: ["purple1", "purple2"],
  nieves: ["nieves", "nieves2"],
  yellow: ["yellow", "yellow2"],
  preparacion: ["pdf_pr1e", "pdf_pr2e", "pdf_pr3e"],
  tortillaFreidora: ["pdf_tf1r", "pdf_tf2r"],
  taquero: ["pdf_tq1r", "pdf_tq2r", "pdf_tq3r"],
  birria: ["pdf_br1a", "pdf_br2a"],
  trastes: ["pdf_tsrea", "pdf_tsr2", "pdf_tsr3", "pdf_tsr4"],
} as const;

export type PaintFamily = keyof typeof PAINT_FAMILIES;

export const PAINT_FAMILY_LABELS: Record<PaintFamily, string> = {
  green: "Green",
  purple: "Purple",
  nieves: "Nieves",
  yellow: "Yellow",
  preparacion: "Preparación",
  tortillaFreidora: "Tortilla Freidora",
  taquero: "Taquero",
  birria: "Birria",
  trastes: "Trastes",
};

export function isPaintFamily(value: unknown): value is PaintFamily {
  return typeof value === "string" && Object.hasOwn(PAINT_FAMILIES, value);
}

export function familyForStation(stationId: string): PaintFamily | null {
  return (Object.keys(PAINT_FAMILIES) as PaintFamily[]).find((family) =>
    (PAINT_FAMILIES[family] as readonly string[]).includes(stationId),
  ) ?? null;
}
