import type { AbilityLevel } from "./types";
import { CAJA_STATIONS, COCINA_STATIONS } from "@/lib/stations";

export type AbilitySeed = {
  stationId: string;
  level: AbilityLevel;
};

/**
 * Seed EmployeeStationAbility rows from schedule Position strings (SPEC §4.3 / §4.7).
 *
 * Defaults (documented in docs/DECISIONS.md):
 * - Cross-board stations are `forbidden`.
 * - Same-board stations default to `ok`, then position overlays apply.
 * - Position overlays: preferred for role home station; training for Prueba on green1;
 *   Limpieza prefers clean and forbids primary cashier lanes.
 */
export function seedAbilitiesFromPositions(positions: string[]): AbilitySeed[] {
  const norms = positions.map((p) => p.trim().toLowerCase());
  const hasCaja = norms.some((p) => p.includes("caja"));
  const hasCocina = norms.some((p) => p.includes("cocina"));

  const byStation = new Map<string, AbilityLevel>();

  if (hasCaja) {
    for (const s of CAJA_STATIONS) {
      byStation.set(s.id, "ok");
    }
    for (const s of COCINA_STATIONS) {
      byStation.set(s.id, "forbidden");
    }
    applyCajaOverlays(norms, byStation);
  }

  if (hasCocina) {
    // Cocina board stations ok (unless already preferred from dual roles)
    for (const s of COCINA_STATIONS) {
      if (!byStation.has(s.id) || byStation.get(s.id) === "forbidden") {
        byStation.set(s.id, "ok");
      }
    }
    // Caja stations forbidden unless employee also has caja (already set)
    if (!hasCaja) {
      for (const s of CAJA_STATIONS) {
        byStation.set(s.id, "forbidden");
      }
    }
    applyCocinaOverlays(norms, byStation);
  }

  // Employees with only "other" positions: no floor abilities seeded
  return [...byStation.entries()].map(([stationId, level]) => ({
    stationId,
    level,
  }));
}

function applyCajaOverlays(
  norms: string[],
  byStation: Map<string, AbilityLevel>,
): void {
  if (norms.some((p) => p === "caja manager")) {
    byStation.set("mana", "preferred");
  }
  if (norms.some((p) => p.includes("nieves"))) {
    byStation.set("nieves", "preferred");
  }
  if (norms.some((p) => p.includes("meser"))) {
    byStation.set("mesero", "preferred");
  }
  if (norms.some((p) => p.includes("limpieza"))) {
    byStation.set("clean", "preferred");
    // Limited stations — primary lanes forbidden for limpieza-only hint
    for (const id of [
      "green1",
      "yellow",
      "purple1",
      "green2",
      "blue",
      "purple2",
      "multi",
      "mana",
    ]) {
      // Don't overwrite preferred if somehow set
      if (byStation.get(id) !== "preferred") {
        byStation.set(id, "forbidden");
      }
    }
  }
  if (norms.some((p) => p.includes("prueba"))) {
    byStation.set("green1", "training");
    byStation.set("green2", "training");
  }
}

function applyCocinaOverlays(
  norms: string[],
  byStation: Map<string, AbilityLevel>,
): void {
  if (norms.some((p) => p.includes("guia abrir"))) {
    byStation.set("guia_abrir", "preferred");
  }
  if (norms.some((p) => p.includes("guia cerrar") || p.includes("cerrar"))) {
    byStation.set("cerrar", "preferred");
  }
}

/** Block assign when ability is forbidden (SPEC §4.7). Missing ability → allow (ok). */
export function isAbilityBlocking(
  level: AbilityLevel | null | undefined,
): boolean {
  return level === "forbidden";
}

/** Sort order for UI: preferred → ok → training → forbidden (last / hidden). */
export function abilitySortRank(level: AbilityLevel | null | undefined): number {
  switch (level) {
    case "preferred":
      return 0;
    case "ok":
    case null:
    case undefined:
      return 1;
    case "training":
      return 2;
    case "forbidden":
      return 3;
    default:
      return 1;
  }
}
