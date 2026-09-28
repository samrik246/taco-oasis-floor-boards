import { prisma } from "@/lib/db";
import { paletteUseStart } from "@/lib/assignments/palette-order";

/**
 * Saved assignment rows per station on this board, for the 28 days before
 * `date`. The payload is station id and count only.
 */
export async function loadStationUse(
  board: "caja" | "cocina",
  date: string,
  stationIds: readonly string[],
): Promise<{ stationId: string; count: number }[]> {
  if (stationIds.length === 0) return [];
  const grouped = await prisma.assignment.groupBy({
    by: ["stationId"],
    where: {
      stationId: { in: [...stationIds] },
      shift: {
        board,
        date: { gte: paletteUseStart(date), lt: date },
      },
    },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((row) => [row.stationId, row._count._all]));
  return stationIds.map((stationId) => ({
    stationId,
    count: counts.get(stationId) ?? 0,
  }));
}
