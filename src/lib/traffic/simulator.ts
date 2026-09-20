/**
 * Fake order-traffic simulator.
 * Advances every 15s when enabled; no real POS / Jolt feed.
 * Ticks all board load stations; callers filter by board for UI.
 */

import {
  allLoadStationDefs,
  busynessFromOrderCount,
  loadStationsForBoard,
  type BusynessLevel,
  type LoadStationDef,
} from "@/lib/load-stations";
import type { FloorBoardId } from "@/lib/board-config";

export const TRAFFIC_TICK_MS = 15_000;

export type LoadMeterSnapshot = {
  loadStationId: string;
  label: string;
  level: BusynessLevel;
  orderCount: number;
  seatIds: readonly string[];
  board: FloorBoardId;
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
  previousCounts?: Record<string, number>;
  stations?: readonly LoadStationDef[];
}): Record<string, number> {
  const stations = args.stations ?? allLoadStationDefs();
  const bucket = Math.floor(args.now.getTime() / TRAFFIC_TICK_MS);
  const next: Record<string, number> = {};

  for (const station of stations) {
    const prev = args.previousCounts?.[station.id] ?? 0;
    const noise = hashSeed(`${station.id}:${bucket}`) % 7; // 0–6 new orders
    const decayed = Math.floor(prev * 0.4);
    next[station.id] = Math.min(14, decayed + noise);
  }

  return next;
}

export function metersFromCounts(
  counts: Record<string, number>,
  stations: readonly LoadStationDef[] = allLoadStationDefs(),
): LoadMeterSnapshot[] {
  return stations.map((s) => ({
    loadStationId: s.id,
    label: s.label,
    level: busynessFromOrderCount(counts[s.id] ?? 0),
    orderCount: counts[s.id] ?? 0,
    seatIds: s.seatIds,
    board: s.board,
  }));
}

export function emptyMeters(
  board?: FloorBoardId,
): LoadMeterSnapshot[] {
  const stations = board
    ? loadStationsForBoard(board)
    : allLoadStationDefs();
  const counts: Record<string, number> = {};
  for (const s of stations) counts[s.id] = 0;
  return metersFromCounts(counts, stations);
}
