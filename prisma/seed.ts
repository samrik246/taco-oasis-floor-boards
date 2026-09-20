import { PrismaClient } from "@prisma/client";
import {
  ALL_STATIONS,
  OBSOLETE_COCINA_STATION_IDS,
} from "../src/lib/stations";
import { allTareaTemplates } from "../src/lib/board-config";
import { allLoadStationDefs } from "../src/lib/load-stations";
import { DEFAULT_PERFORMANCE_QUESTIONS } from "../src/lib/performance/questions";

const prisma = new PrismaClient();

async function main() {
  // Remove obsolete Kitchen stations (pre–Kitchen-phase seeds) if unused.
  for (const id of OBSOLETE_COCINA_STATION_IDS) {
    const assignments = await prisma.assignment.count({
      where: { stationId: id },
    });
    if (assignments > 0) continue;
    await prisma.employeeStationAbility.deleteMany({
      where: { stationId: id },
    });
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

  for (const t of allTareaTemplates()) {
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
      },
      update: {
        code: t.code,
        label: t.label,
        mode: t.mode,
        sortOrder: t.sortOrder,
        board: t.board,
        lemonWarnOnGreens: t.lemonWarnOnGreens === true,
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

  for (const q of DEFAULT_PERFORMANCE_QUESTIONS) {
    await prisma.performanceQuestion.upsert({
      where: { id: q.id },
      create: {
        id: q.id,
        prompt: q.prompt,
        kind: q.kind,
        sortOrder: q.sortOrder,
        active: true,
      },
      update: {
        prompt: q.prompt,
        kind: q.kind,
        sortOrder: q.sortOrder,
        active: true,
      },
    });
  }

  const count = await prisma.station.count();
  const tareas = await prisma.tareaTemplate.count();
  const questions = await prisma.performanceQuestion.count();
  console.log(
    `Seeded ${count} stations, ${tareas} tarea templates, ${questions} performance questions, traffic meters.`,
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
