/**
 * Fake order-traffic simulator.
 * Advances every 15s when enabled; no real POS / Jolt feed.
 * Covers Cashiers + Kitchen load stations; callers filter by board.
 */

import {
  allLoadStationDefs,
  busynessFromOrderCount,
  CASHIER_LOAD_STATIONS,
  KITCHEN_LOAD_STATIONS,
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

function defsForBoard(board?: FloorBoardId): readonly LoadStationDef[] {
  if (board === "caja") return CASHIER_LOAD_STATIONS;
  if (board === "cocina") return KITCHEN_LOAD_STATIONS;
  return allLoadStationDefs();
}

/**
 * Simulate one tick of fake orders per load station.
 * Uses time bucket so concurrent callers in the same 15s window get similar levels.
 */
export function simulateTick(args: {
  now: Date;
  previousCounts?: Record<string, number>;
  board?: FloorBoardId;
}): Record<string, number> {
  const bucket = Math.floor(args.now.getTime() / TRAFFIC_TICK_MS);
  const defs = defsForBoard(args.board);
  const next: Record<string, number> = {};

  for (const station of defs) {
    const prev = args.previousCounts?.[station.id] ?? 0;
    const noise = hashSeed(`${station.id}:${bucket}`) % 7; // 0–6 new orders
    const decayed = Math.floor(prev * 0.4);
    next[station.id] = Math.min(14, decayed + noise);
  }

  return next;
}

export function metersFromCounts(
  counts: Record<string, number>,
  board?: FloorBoardId,
): LoadMeterSnapshot[] {
  return defsForBoard(board).map((s) => ({
    loadStationId: s.id,
    label: s.label,
    level: busynessFromOrderCount(counts[s.id] ?? 0),
    orderCount: counts[s.id] ?? 0,
    seatIds: s.seatIds,
  }));
}

export function emptyMeters(board?: FloorBoardId): LoadMeterSnapshot[] {
  const counts: Record<string, number> = {};
  for (const s of defsForBoard(board)) counts[s.id] = 0;
  return metersFromCounts(counts, board);
}
