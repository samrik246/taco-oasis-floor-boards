import { prisma } from "@/lib/db";
import {
  allLoadStationDefs,
  CASHIER_LOAD_STATIONS,
  KITCHEN_LOAD_STATIONS,
} from "@/lib/load-stations";
import type { FloorBoardId } from "@/lib/board-config";
import {
  emptyMeters,
  metersFromCounts,
  simulateTick,
  TRAFFIC_TICK_MS,
  type TrafficStateSnapshot,
} from "@/lib/traffic/simulator";
import { processReturnToStation } from "@/lib/tareas/return-service";

async function ensureConfig() {
  return prisma.trafficSimulatorConfig.upsert({
    where: { id: "default" },
    create: { id: "default", enabled: false },
    update: {},
  });
}

async function ensureMeters() {
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
}

function defsForBoard(board?: FloorBoardId) {
  if (board === "caja") return CASHIER_LOAD_STATIONS;
  if (board === "cocina") return KITCHEN_LOAD_STATIONS;
  return allLoadStationDefs();
}

export async function getTrafficState(
  board?: FloorBoardId,
): Promise<TrafficStateSnapshot> {
  await ensureConfig();
  await ensureMeters();
  const config = await prisma.trafficSimulatorConfig.findUniqueOrThrow({
    where: { id: "default" },
  });
  const rows = await prisma.loadStationMeter.findMany();
  const byId = Object.fromEntries(rows.map((r) => [r.loadStationId, r]));
  const defs = defsForBoard(board);
  const meters = defs.map((s) => {
    const row = byId[s.id];
    return {
      loadStationId: s.id,
      label: s.label,
      level: (row?.level ?? "quiet") as "quiet" | "busy" | "slammed",
      orderCount: row?.orderCount ?? 0,
      seatIds: s.seatIds,
    };
  });
  return {
    enabled: config.enabled,
    lastTickAt: config.lastTickAt?.toISOString() ?? null,
    meters: meters.length ? meters : emptyMeters(board),
  };
}

export async function setTrafficEnabled(
  enabled: boolean,
  board?: FloorBoardId,
): Promise<TrafficStateSnapshot> {
  await ensureConfig();
  await prisma.trafficSimulatorConfig.update({
    where: { id: "default" },
    data: { enabled },
  });
  if (enabled) {
    return tickTrafficIfDue({ force: true, board });
  }
  return getTrafficState(board);
}

/**
 * Advance fake order meters when simulator is on and ≥15s since last tick
 * (or force). Also runs return-to-station processing for the given date/hour.
 */
export async function tickTrafficIfDue(opts?: {
  force?: boolean;
  date?: string;
  hour?: number;
  board?: FloorBoardId;
}): Promise<TrafficStateSnapshot> {
  await ensureConfig();
  await ensureMeters();
  const config = await prisma.trafficSimulatorConfig.findUniqueOrThrow({
    where: { id: "default" },
  });

  if (!config.enabled && !opts?.force) {
    return getTrafficState(opts?.board);
  }

  const now = new Date();
  const due =
    opts?.force ||
    !config.lastTickAt ||
    now.getTime() - config.lastTickAt.getTime() >= TRAFFIC_TICK_MS;

  if (!due || !config.enabled) {
    return getTrafficState(opts?.board);
  }

  const previous = await prisma.loadStationMeter.findMany();
  const prevCounts = Object.fromEntries(
    previous.map((p) => [p.loadStationId, p.orderCount]),
  ) as Record<string, number>;

  // Always advance all load stations so both boards stay warm
  const counts = simulateTick({ now, previousCounts: prevCounts });
  const meters = metersFromCounts(counts);

  for (const m of meters) {
    await prisma.loadStationMeter.upsert({
      where: { loadStationId: m.loadStationId },
      create: {
        loadStationId: m.loadStationId,
        level: m.level,
        orderCount: m.orderCount,
      },
      update: {
        level: m.level,
        orderCount: m.orderCount,
      },
    });
  }

  await prisma.trafficSimulatorConfig.update({
    where: { id: "default" },
    data: { lastTickAt: now },
  });

  if (opts?.date != null && opts?.hour != null) {
    await processReturnToStation({
      date: opts.date,
      hour: opts.hour,
      board: opts.board,
    });
  }

  return getTrafficState(opts?.board);
}
