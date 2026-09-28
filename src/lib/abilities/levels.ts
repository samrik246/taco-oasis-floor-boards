import {
  PAINT_FAMILIES,
  PAINT_FAMILY_LABELS,
  familyForStation,
  type PaintFamily,
} from "@/lib/assignments/paint-families";
import type { AbilityLevel } from "@/lib/rules/types";
import { COCINA_STATIONS } from "@/lib/stations";

/** Stored value → the word on the grid and on both board catalogs. */
export const ABILITY_WORD: Record<AbilityLevel, string> = {
  forbidden: "no",
  training: "entrenando",
  ok: "bien",
  preferred: "fuerte",
};

export const MIXED_WORD = "mixto";

const CYCLE: AbilityLevel[] = ["forbidden", "training", "ok", "preferred"];

/** Cocina paint families. Caja families are not grid columns. */
const COCINA_FAMILIES = [
  "preparacion",
  "tortillaFreidora",
  "taquero",
  "birria",
  "trastes",
] as const satisfies readonly PaintFamily[];

export type AbilityColumn = {
  key: string;
  label: string;
  kind: "family" | "station";
  stationIds: readonly string[];
};

export type CellLevel = AbilityLevel | "mixed";

/**
 * One column per cocina paint family and one per station that has no family,
 * in board sort order. A family takes the place of its earliest station.
 */
export function cocinaAbilityColumns(): AbilityColumn[] {
  const cocinaFamilies = new Set<string>(COCINA_FAMILIES);
  const ordered = COCINA_STATIONS.map((station, index) => ({ station, index })).sort(
    (a, b) => a.station.sortOrder - b.station.sortOrder || a.index - b.index,
  );
  const columns: AbilityColumn[] = [];
  const seenFamilies = new Set<string>();
  for (const { station } of ordered) {
    const family = familyForStation(station.id);
    if (family && cocinaFamilies.has(family)) {
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);
      columns.push({
        key: family,
        label: PAINT_FAMILY_LABELS[family],
        kind: "family",
        stationIds: PAINT_FAMILIES[family],
      });
      continue;
    }
    columns.push({
      key: station.id,
      label: station.label,
      kind: "station",
      stationIds: [station.id],
    });
  }
  return columns;
}

export function abilityColumn(key: string): AbilityColumn | null {
  return cocinaAbilityColumns().find((column) => column.key === key) ?? null;
}

/** A missing row reads as ok (bien). Disagreement inside a family is mixed. */
export function cellLevel(
  stationIds: readonly string[],
  rows: readonly { stationId: string; level: string }[],
): CellLevel {
  const byStation = new Map(rows.map((row) => [row.stationId, row.level]));
  const levels = stationIds.map((id) => byStation.get(id) ?? "ok");
  const first = levels[0] ?? "ok";
  return levels.every((level) => level === first) ? (first as AbilityLevel) : "mixed";
}

/** no → entrenando → bien → fuerte → no. A mixed family opens on bien. */
export function nextStoredLevel(current: CellLevel): AbilityLevel {
  if (current === "mixed") return "ok";
  const index = CYCLE.indexOf(current);
  return CYCLE[(index + 1) % CYCLE.length]!;
}

export function cellWord(level: CellLevel): string {
  return level === "mixed" ? MIXED_WORD : ABILITY_WORD[level];
}
