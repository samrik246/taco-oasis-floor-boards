import { PrismaClient } from "../src/lib/prisma-client";
import { applyS14StationColours, formatS14StationColourCounts } from "../src/lib/s14-station-colours";

async function main() {
  const prisma = new PrismaClient();
  try {
    const counts = await applyS14StationColours(prisma);
    console.log(formatS14StationColourCounts(counts));
  } finally {
    await prisma.$disconnect();
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("s14-station-colours.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
