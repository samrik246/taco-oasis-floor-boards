import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "../src/lib/stations";

const prisma = new PrismaClient();

async function main() {
  for (const s of ALL_STATIONS) {
    await prisma.station.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        board: s.board,
        label: s.label,
        color: s.color,
        maxConcurrent: s.maxConcurrent,
        sortOrder: s.sortOrder,
        priority: s.priority,
      },
      update: {
        board: s.board,
        label: s.label,
        color: s.color,
        maxConcurrent: s.maxConcurrent,
        sortOrder: s.sortOrder,
        priority: s.priority,
      },
    });
  }
  const count = await prisma.station.count();
  console.log(`Seeded ${count} stations (${ALL_STATIONS.length} defined).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
