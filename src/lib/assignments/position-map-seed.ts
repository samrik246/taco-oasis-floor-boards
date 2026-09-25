import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";

/** Planner G bootstrap: the known When I Work position strings, exact text. */
export const POSITION_STATION_MAP_SEED: { position: string; stationId: string }[] = [
  { position: "Caja Manager", stationId: "mana" },
  { position: "Caja - Nieves", stationId: "nieves" },
  { position: "Caja - Meser@", stationId: "mesero" },
  { position: "Cocina Guia Abrir", stationId: "pdf_guia" },
  { position: "Cocina Guia Cerrar", stationId: "pdf_guia" },
];

export type PositionMapSeedSummary = {
  added: number;
  stationMissing: number;
};

/**
 * Idempotent: a key only seeds when absent. An existing row — including one
 * a manager cleared to no station in Back office — is left exactly as
 * saved. A mapped station that doesn't exist on this database yet skips
 * that key rather than failing the whole seed.
 */
export async function seedPositionStationMap(
  prisma: PrismaClient = defaultPrisma,
): Promise<PositionMapSeedSummary> {
  let added = 0;
  let stationMissing = 0;
  for (const row of POSITION_STATION_MAP_SEED) {
    const station = await prisma.station.findUnique({ where: { id: row.stationId } });
    if (!station) {
      stationMissing += 1;
      console.warn(
        `Position map seed: station "${row.stationId}" not found, skipped "${row.position}".`,
      );
      continue;
    }
    const existing = await prisma.positionStationMap.findUnique({
      where: { position: row.position },
    });
    if (existing) continue;
    await prisma.positionStationMap.create({
      data: { position: row.position, stationId: row.stationId },
    });
    added += 1;
  }
  return { added, stationMissing };
}
