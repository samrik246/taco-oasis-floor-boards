import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "../src/lib/stations";
import { CASHIER_TAREA_TEMPLATES } from "../src/lib/tareas/catalog";
import { CASHIER_LOAD_STATIONS } from "../src/lib/load-stations";

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

  for (const t of CASHIER_TAREA_TEMPLATES) {
    await prisma.tareaTemplate.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        code: t.code,
        label: t.label,
        mode: t.mode,
        sortOrder: t.sortOrder,
        lemonWarnOnGreens: t.lemonWarnOnGreens === true,
      },
      update: {
        code: t.code,
        label: t.label,
        mode: t.mode,
        sortOrder: t.sortOrder,
        lemonWarnOnGreens: t.lemonWarnOnGreens === true,
      },
    });
  }

  await prisma.trafficSimulatorConfig.upsert({
    where: { id: "default" },
    create: { id: "default", enabled: false },
    update: {},
  });

  for (const s of CASHIER_LOAD_STATIONS) {
    await prisma.loadStationMeter.upsert({
      where: { loadStationId: s.id },
      create: {
        loadStationId: s.id,
        level: "quiet",
        orderCount: 0,
      },
      update: {},
    });
  }

  const count = await prisma.station.count();
  const tareas = await prisma.tareaTemplate.count();
  console.log(
    `Seeded ${count} stations, ${tareas} tarea templates, traffic meters.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
