import {
  PAINT_FAMILIES,
  PAINT_FAMILY_LABELS,
  familyForStation,
  type PaintFamily,
} from "@/lib/assignments/paint-families";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import type { AbilityLevel } from "@/lib/rules/types";
import { CAJA_STATIONS, COCINA_STATIONS, type StationSeed } from "@/lib/stations";

/** Stored value → the word on the Habilidades grid. The Employees panel keeps its own word. */
export const ABILITY_WORD: Record<AbilityLevel, string> = {
  forbidden: "no",
  training: "poco",
  ok: "bien",
  preferred: "fuerte",
};

export const MIXED_WORD = "mixto";

const CYCLE: AbilityLevel[] = ["forbidden", "training", "ok", "preferred"];

const COCINA_FAMILIES = [
  "preparacion",
  "tortillaFreidora",
  "taquero",
  "birria",
  "trastes",
] as const satisfies readonly PaintFamily[];

const CAJA_FAMILIES = ["green", "purple", "nieves", "yellow"] as const satisfies readonly PaintFamily[];

export type AbilityColumn = {
  key: string;
  label: string;
  kind: "family" | "station";
  stationIds: readonly string[];
  color: string;
};

export type CellLevel = AbilityLevel | "mixed";

/**
 * One column per paint family on the board and one per station that has no
 * family, in board sort order. A family takes the place of its earliest station.
 */
function abilityColumnsFor(
  stations: readonly StationSeed[],
  families: ReadonlySet<string>,
): AbilityColumn[] {
  const ordered = stations.map((station, index) => ({ station, index })).sort(
    (a, b) => a.station.sortOrder - b.station.sortOrder || a.index - b.index,
  );
  const columns: AbilityColumn[] = [];
  const seenFamilies = new Set<string>();
  for (const { station } of ordered) {
    const family = familyForStation(station.id);
    if (family && families.has(family)) {
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);
      const firstId = PAINT_FAMILIES[family][0];
      const first = stations.find((item) => item.id === firstId);
      columns.push({
        key: family,
        label: PAINT_FAMILY_LABELS[family],
        kind: "family",
        stationIds: PAINT_FAMILIES[family],
        color: first?.color ?? station.color,
      });
      continue;
    }
    columns.push({
      key: station.id,
      label: station.label,
      kind: "station",
      stationIds: [station.id],
      color: station.color,
    });
  }
  return columns;
}

export function cocinaAbilityColumns(): AbilityColumn[] {
  return abilityColumnsFor(COCINA_STATIONS, new Set<string>(COCINA_FAMILIES));
}

export function cajaAbilityColumns(): AbilityColumn[] {
  return abilityColumnsFor(CAJA_STATIONS, new Set<string>(CAJA_FAMILIES));
}

export function abilityColumn(key: string): AbilityColumn | null {
  return (
    cajaAbilityColumns().find((column) => column.key === key) ??
    cocinaAbilityColumns().find((column) => column.key === key) ??
    null
  );
}

/** A missing row reads as the column default, or ok when the column has none. */
export function cellLevel(
  stationIds: readonly string[],
  rows: readonly { stationId: string; level: string }[],
  defaults?: ReadonlyMap<string, string>,
): CellLevel {
  const byStation = new Map(rows.map((row) => [row.stationId, row.level]));
  const levels = stationIds.map((id) => levelWhenUnset(byStation.get(id), defaults?.get(id)) ?? "ok");
  const first = levels[0] ?? "ok";
  return levels.every((level) => level === first) ? (first as AbilityLevel) : "mixed";
}

/** no → poco → bien → fuerte → no. A mixed family opens on bien. */
export function nextStoredLevel(current: CellLevel): AbilityLevel {
  if (current === "mixed") return "ok";
  const index = CYCLE.indexOf(current);
  return CYCLE[(index + 1) % CYCLE.length]!;
}

export function cellWord(level: CellLevel): string {
  return level === "mixed" ? MIXED_WORD : ABILITY_WORD[level];
}
