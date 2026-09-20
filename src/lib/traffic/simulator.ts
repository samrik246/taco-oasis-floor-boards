/**
 * Fake order-traffic simulator (Phase 1).
 * Advances every 15s when enabled; no real POS / Jolt feed.
 */

import {
  busynessFromOrderCount,
  CASHIER_LOAD_STATIONS,
  type BusynessLevel,
  type LoadStationId,
} from "@/lib/load-stations";

export const TRAFFIC_TICK_MS = 15_000;

export type LoadMeterSnapshot = {
  loadStationId: LoadStationId;
  label: string;
  level: BusynessLevel;
  orderCount: number;
  seatIds: readonly string[];
};

export type TrafficStateSnapshot = {
  enabled: boolean;
  lastTickAt: string | null;
  meters: LoadMeterSnapshot[];
};

/** Deterministic-ish pseudo-random from seed string */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Simulate one tick of fake orders per load station.
 * Uses time bucket so concurrent callers in the same 15s window get similar levels.
 */
export function simulateTick(args: {
  now: Date;
  previousCounts?: Partial<Record<LoadStationId, number>>;
}): Record<LoadStationId, number> {
  const bucket = Math.floor(args.now.getTime() / TRAFFIC_TICK_MS);
  const next: Record<LoadStationId, number> = {
    nieves: 0,
    cliente: 0,
    carro: 0,
    expo: 0,
  };

  for (const station of CASHIER_LOAD_STATIONS) {
    const prev = args.previousCounts?.[station.id] ?? 0;
    const noise = hashSeed(`${station.id}:${bucket}`) % 7; // 0–6 new orders
    // Decay prior window (~40%) then add noise
    const decayed = Math.floor(prev * 0.4);
    next[station.id] = Math.min(14, decayed + noise);
  }

  return next;
}

export function metersFromCounts(
  counts: Record<LoadStationId, number>,
): LoadMeterSnapshot[] {
  return CASHIER_LOAD_STATIONS.map((s) => ({
    loadStationId: s.id,
    label: s.label,
    level: busynessFromOrderCount(counts[s.id] ?? 0),
    orderCount: counts[s.id] ?? 0,
    seatIds: s.seatIds,
  }));
}

export function emptyMeters(): LoadMeterSnapshot[] {
  return metersFromCounts({
    nieves: 0,
    cliente: 0,
    carro: 0,
    expo: 0,
  });
}
