import { PrismaClient } from "@prisma/client";
import {
  POSITION_STATION_MAP_SEED,
  seedPositionStationMap,
} from "../src/lib/assignments/position-map-seed";

const prisma = new PrismaClient();

/**
 * Planner G bootstrap, run by the installer — never the full `prisma/seed.ts`
 * demo seed — against the live board. Idempotent: an existing row (including
 * one a manager cleared to no station) is left exactly as saved.
 */
async function main() {
  const { added, stationMissing } = await seedPositionStationMap(prisma);
  const present = POSITION_STATION_MAP_SEED.length - added - stationMissing;
  console.log(`seed map added=${added} present=${present} station-missing=${stationMissing}`);
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
