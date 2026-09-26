export const PAINT_FAMILIES = {
  nieves: ["nieves", "nieves2"],
  trastes: ["pdf_tsrea", "pdf_tsr2", "pdf_tsr3", "pdf_tsr4"],
} as const;

export type PaintFamily = keyof typeof PAINT_FAMILIES;

export function isPaintFamily(value: unknown): value is PaintFamily {
  return value === "nieves" || value === "trastes";
}

export function familyForStation(stationId: string): PaintFamily | null {
  return (Object.keys(PAINT_FAMILIES) as PaintFamily[]).find((family) =>
    (PAINT_FAMILIES[family] as readonly string[]).includes(stationId),
  ) ?? null;
}
