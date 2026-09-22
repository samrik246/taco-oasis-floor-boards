import { PrismaClient } from "@prisma/client";
import {
  ALL_STATIONS,
  OBSOLETE_COCINA_STATION_IDS,
} from "../src/lib/stations";
import { allTareaTemplates } from "../src/lib/board-config";
import { allLoadStationDefs } from "../src/lib/load-stations";
import { DEFAULT_PERFORMANCE_QUESTIONS } from "../src/lib/performance/questions";
import {
  DEMO_MANAGERS,
  hashManagerCode,
} from "../src/lib/managers/codes";
import { historicalSaleRows } from "../src/lib/rush/historical-sales";
import { STATION_SHORT_CODES } from "../src/lib/schedule/station-codes";

const prisma = new PrismaClient();

const useDemoManagerCodes = process.env.DEMO_MANAGER_CODES === "1";
const initialManagerName = process.env.INITIAL_MANAGER_NAME?.trim();
const initialManagerCode = process.env.INITIAL_MANAGER_CODE?.trim();
const hasInitialManager = Boolean(
  initialManagerName && initialManagerCode && initialManagerCode.length >= 4 && initialManagerCode.length <= 64,
);

async function seedInitialManagers() {
  const existingCount = await prisma.manager.count();
  if (existingCount > 0) return existingCount;

  if (useDemoManagerCodes) {
    for (const manager of DEMO_MANAGERS) {
      await prisma.manager.create({
        data: {
          name: manager.name,
          codeHash: hashManagerCode(manager.code),
          active: true,
        },
      });
    }
    return DEMO_MANAGERS.length;
  }

  if (!hasInitialManager) {
    throw new Error(
      "An empty database needs INITIAL_MANAGER_NAME and a trimmed 4–64 character INITIAL_MANAGER_CODE. Use DEMO_MANAGER_CODES=1 only for local demos.",
    );
  }

  await prisma.manager.create({
    data: {
      name: initialManagerName!,
      codeHash: hashManagerCode(initialManagerCode!),
      active: true,
    },
  });
  return 1;
}

async function main() {
  // Fail before modifying an empty production database that would have no manager.
  const existingManagers = await prisma.manager.count();
  if (
    existingManagers === 0 &&
    !useDemoManagerCodes &&
    !hasInitialManager
  ) {
    throw new Error(
      "An empty database needs INITIAL_MANAGER_NAME and a trimmed 4–64 character INITIAL_MANAGER_CODE. Use DEMO_MANAGER_CODES=1 only for local demos.",
    );
  }

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
        shortCode: STATION_SHORT_CODES[s.id] ?? "",
      },
      update: {
        // Existing station edits belong to the manager, not to a release seed.
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
      update: {},
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
      update: {},
    });
  }

  const managers = await seedInitialManagers();

  const sales = historicalSaleRows();
  // Do not replace a manager's edited sales history on an ordinary bootstrap.
  for (const sale of sales) {
    await prisma.historicalHourlySale.upsert({
      where: { board_dow_hour_week: { board: sale.board, dow: sale.dow, hour: sale.hour, week: sale.week } },
      create: sale,
      update: {},
    });
  }

  const count = await prisma.station.count();
  const tareas = await prisma.tareaTemplate.count();
  const questions = await prisma.performanceQuestion.count();
  console.log(
    `Seeded ${count} stations, ${tareas} tarea templates, ${questions} performance questions, ${managers} managers, ${sales.length} historical hourly sales, traffic meters.`,
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
