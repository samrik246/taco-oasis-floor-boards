/**
 * Shared board-config template foundation.
 * Each floor board = stations + load-station map + tarea catalog + rules flags.
 * Cashiers (caja) and Kitchen (cocina) are two instances of the same shape.
 */

import type { BoardKind } from "@/lib/constants";
import { CAJA_STATIONS, COCINA_STATIONS, type StationSeed } from "@/lib/stations";
import {
  CASHIER_LOAD_STATIONS,
  KITCHEN_LOAD_STATIONS,
  type LoadStationDef,
} from "@/lib/load-stations";
import {
  CASHIER_TAREA_TEMPLATES,
  KITCHEN_TAREA_TEMPLATES,
  type TareaTemplateSeed,
} from "@/lib/tareas/catalog";

export type FloorBoardId = Exclude<BoardKind, "other">;

export type BoardRulesFlags = {
  /** One person per station (maxConcurrent enforced). */
  noDoubles: boolean;
  /** Multiple working tareas per person OK. */
  multiActiveTareas: boolean;
  /** Slammed load → auto-unassign tareas + return prompt. */
  returnOnSlammed: boolean;
  /** Seat ids that get return prompts when helping (e.g. MULTI). */
  floaterSeatIds: readonly string[];
  /** Seats that trigger lemon-style warn for flagged tareas. */
  lemonWarnSeatIds: readonly string[];
};

export type BoardConfig = {
  id: FloorBoardId;
  label: string;
  stations: readonly StationSeed[];
  loadStations: readonly LoadStationDef[];
  tareaTemplates: readonly TareaTemplateSeed[];
  rules: BoardRulesFlags;
};

export const CAJA_BOARD_CONFIG: BoardConfig = {
  id: "caja",
  label: "Cashiers",
  stations: CAJA_STATIONS,
  loadStations: CASHIER_LOAD_STATIONS,
  tareaTemplates: CASHIER_TAREA_TEMPLATES,
  rules: {
    noDoubles: true,
    multiActiveTareas: true,
    returnOnSlammed: true,
    floaterSeatIds: ["multi"],
    lemonWarnSeatIds: ["green1", "green2"],
  },
};

export const COCINA_BOARD_CONFIG: BoardConfig = {
  id: "cocina",
  label: "Kitchen",
  stations: COCINA_STATIONS,
  loadStations: KITCHEN_LOAD_STATIONS,
  tareaTemplates: KITCHEN_TAREA_TEMPLATES,
  rules: {
    noDoubles: true,
    multiActiveTareas: true,
    returnOnSlammed: true,
    floaterSeatIds: [],
    lemonWarnSeatIds: [],
  },
};

export const BOARD_CONFIGS: Record<FloorBoardId, BoardConfig> = {
  caja: CAJA_BOARD_CONFIG,
  cocina: COCINA_BOARD_CONFIG,
};

export function getBoardConfig(board: FloorBoardId): BoardConfig {
  return BOARD_CONFIGS[board];
}

export function isFloorBoardId(value: string): value is FloorBoardId {
  return value === "caja" || value === "cocina";
}

/** All load-station defs across floor boards (for global simulator). */
export function allLoadStations(): readonly LoadStationDef[] {
  return [...CASHIER_LOAD_STATIONS, ...KITCHEN_LOAD_STATIONS];
}

/** All tarea templates across boards. */
export function allTareaTemplates(): readonly TareaTemplateSeed[] {
  return [...CASHIER_TAREA_TEMPLATES, ...KITCHEN_TAREA_TEMPLATES];
}
