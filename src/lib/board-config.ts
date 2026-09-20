/**
 * Shared board-config hooks — catalogs are not caja-only hardcode.
 * Minimal template surface enough for Kitchen + Cashiers.
 */

import type { BoardKind } from "@/lib/constants";
import {
  CAJA_STATIONS,
  COCINA_STATIONS,
  type StationSeed,
} from "@/lib/stations";
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
import {
  DEFAULT_PERFORMANCE_QUESTIONS,
  type PerformanceQuestionDef,
} from "@/lib/performance/questions";

export type FloorBoardId = Exclude<BoardKind, "other">;

export type BoardConfig = {
  id: FloorBoardId;
  label: string;
  stations: readonly StationSeed[];
  loadStations: readonly LoadStationDef[];
  tareaTemplates: readonly TareaTemplateSeed[];
  /** Kitchen has no MULTI floater seat; cashiers do. */
  multiSeatId: string | null;
  rules: {
    onePersonPerStation: boolean;
    multiActiveTareas: boolean;
    returnToStationOnSlammed: boolean;
  };
};

const CAJA_CONFIG: BoardConfig = {
  id: "caja",
  label: "Cashiers",
  stations: CAJA_STATIONS,
  loadStations: CASHIER_LOAD_STATIONS,
  tareaTemplates: CASHIER_TAREA_TEMPLATES,
  multiSeatId: "multi",
  rules: {
    onePersonPerStation: true,
    multiActiveTareas: true,
    returnToStationOnSlammed: true,
  },
};

const COCINA_CONFIG: BoardConfig = {
  id: "cocina",
  label: "Kitchen",
  stations: COCINA_STATIONS,
  loadStations: KITCHEN_LOAD_STATIONS,
  tareaTemplates: KITCHEN_TAREA_TEMPLATES,
  multiSeatId: null,
  rules: {
    onePersonPerStation: true,
    multiActiveTareas: true,
    returnToStationOnSlammed: true,
  },
};

const BY_BOARD: Record<FloorBoardId, BoardConfig> = {
  caja: CAJA_CONFIG,
  cocina: COCINA_CONFIG,
};

export function boardConfig(board: FloorBoardId): BoardConfig {
  return BY_BOARD[board];
}

export function stationsForBoard(board: FloorBoardId): readonly StationSeed[] {
  return boardConfig(board).stations;
}

export function loadStationsForBoard(
  board: FloorBoardId,
): readonly LoadStationDef[] {
  return boardConfig(board).loadStations;
}

export function tareaTemplatesForBoard(
  board: FloorBoardId,
): readonly TareaTemplateSeed[] {
  return boardConfig(board).tareaTemplates;
}

export function allLoadStations(): readonly LoadStationDef[] {
  return [...CASHIER_LOAD_STATIONS, ...KITCHEN_LOAD_STATIONS];
}

export function allTareaTemplates(): readonly TareaTemplateSeed[] {
  return [...CASHIER_TAREA_TEMPLATES, ...KITCHEN_TAREA_TEMPLATES];
}

export function performanceQuestions(): readonly PerformanceQuestionDef[] {
  return DEFAULT_PERFORMANCE_QUESTIONS;
}

export function isFloorBoard(value: string): value is FloorBoardId {
  return value === "caja" || value === "cocina";
}

/** Resolve which board owns a load-station id (first match). */
export function boardForLoadStation(
  loadStationId: string,
): FloorBoardId | null {
  if (CASHIER_LOAD_STATIONS.some((s) => s.id === loadStationId)) return "caja";
  if (KITCHEN_LOAD_STATIONS.some((s) => s.id === loadStationId)) return "cocina";
  return null;
}
