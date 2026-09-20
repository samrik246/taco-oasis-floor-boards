import { prisma } from "@/lib/db";
import {
  CASHIER_LOAD_STATIONS,
  type LoadStationId,
} from "@/lib/load-stations";
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
}

export async function getTrafficState(): Promise<TrafficStateSnapshot> {
  await ensureConfig();
  await ensureMeters();
  const config = await prisma.trafficSimulatorConfig.findUniqueOrThrow({
    where: { id: "default" },
  });
  const rows = await prisma.loadStationMeter.findMany();
  const byId = Object.fromEntries(rows.map((r) => [r.loadStationId, r]));
  const meters = CASHIER_LOAD_STATIONS.map((s) => {
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
    meters: meters.length ? meters : emptyMeters(),
  };
}

export async function setTrafficEnabled(enabled: boolean): Promise<TrafficStateSnapshot> {
  await ensureConfig();
  await prisma.trafficSimulatorConfig.update({
    where: { id: "default" },
    data: { enabled },
  });
  if (enabled) {
    return tickTrafficIfDue({ force: true });
  }
  return getTrafficState();
}

/**
 * Advance fake order meters when simulator is on and ≥15s since last tick
 * (or force). Also runs return-to-station processing for the given date/hour.
 */
export async function tickTrafficIfDue(opts?: {
  force?: boolean;
  date?: string;
  hour?: number;
}): Promise<TrafficStateSnapshot> {
  await ensureConfig();
  await ensureMeters();
  const config = await prisma.trafficSimulatorConfig.findUniqueOrThrow({
    where: { id: "default" },
  });

  if (!config.enabled && !opts?.force) {
    return getTrafficState();
  }
  if (!config.enabled && opts?.force) {
    // force only when enabling path already set enabled
  }

  const now = new Date();
  const due =
    opts?.force ||
    !config.lastTickAt ||
    now.getTime() - config.lastTickAt.getTime() >= TRAFFIC_TICK_MS;

  if (!due || !config.enabled) {
    return getTrafficState();
  }

  const previous = await prisma.loadStationMeter.findMany();
  const prevCounts = Object.fromEntries(
    previous.map((p) => [p.loadStationId, p.orderCount]),
  ) as Partial<Record<LoadStationId, number>>;

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
    await processReturnToStation({ date: opts.date, hour: opts.hour });
  }

  return getTrafficState();
}
