import { PrismaClient } from "@prisma/client";
import {
  ALL_STATIONS,
  LEGACY_COCINA_STATION_IDS,
} from "../src/lib/stations";
import { ALL_TAREA_TEMPLATES } from "../src/lib/tareas/catalog";
import { allLoadStationDefs } from "../src/lib/load-stations";

const prisma = new PrismaClient();

async function main() {
  // Remove obsolete cocina stations (abilities cascade via relation? abilities need station)
  for (const id of LEGACY_COCINA_STATION_IDS) {
    await prisma.employeeStationAbility.deleteMany({ where: { stationId: id } });
    await prisma.assignment.deleteMany({ where: { stationId: id } });
    await prisma.station.deleteMany({ where: { id } });
  }

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

  for (const t of ALL_TAREA_TEMPLATES) {
    await prisma.tareaTemplate.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        code: t.code,
        label: t.label,
        mode: t.mode,
        sortOrder: t.sortOrder,
        board: t.board,
        lemonWarnOnGreens: t.lemonWarnOnGreens === true,
        preferSeatId: t.preferSeatId ?? null,
        warnOnSlammedLoadStationId: t.warnOnSlammedLoadStationId ?? null,
      },
      update: {
        code: t.code,
        label: t.label,
        mode: t.mode,
        sortOrder: t.sortOrder,
        board: t.board,
        lemonWarnOnGreens: t.lemonWarnOnGreens === true,
        preferSeatId: t.preferSeatId ?? null,
        warnOnSlammedLoadStationId: t.warnOnSlammedLoadStationId ?? null,
      },
    });
  }

  await prisma.trafficSimulatorConfig.upsert({
    where: { id: "default" },
    create: { id: "default", enabled: false },
    update: {},
  });

  for (const s of allLoadStationDefs()) {
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
  const meters = await prisma.loadStationMeter.count();
  console.log(
    `Seeded ${count} stations, ${tareas} tarea templates, ${meters} traffic meters.`,
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
