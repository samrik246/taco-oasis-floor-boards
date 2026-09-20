import type { BoardKind } from "./constants";

export type StationSeed = {
  id: string;
  board: Exclude<BoardKind, "other">;
  label: string;
  color: string;
  maxConcurrent: number; // -1 = unlimited
  sortOrder: number;
  priority: number | null;
};

/** Caja stations — SPEC §4.4 */
export const CAJA_STATIONS: StationSeed[] = [
  { id: "mana", board: "caja", label: "MANA (Manager)", color: "pink", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "green1", board: "caja", label: "Green 1", color: "green", maxConcurrent: 1, sortOrder: 1, priority: 1 },
  { id: "yellow", board: "caja", label: "Yellow / Outside", color: "yellow", maxConcurrent: 1, sortOrder: 2, priority: 2 },
  { id: "purple1", board: "caja", label: "Purple 1", color: "purple", maxConcurrent: 1, sortOrder: 3, priority: 3 },
  { id: "green2", board: "caja", label: "Green 2 / Jolt", color: "lime", maxConcurrent: 1, sortOrder: 4, priority: 4 },
  { id: "blue", board: "caja", label: "Blue / Outside", color: "blue", maxConcurrent: 1, sortOrder: 5, priority: 5 },
  { id: "purple2", board: "caja", label: "Purple 2", color: "lavender", maxConcurrent: 1, sortOrder: 6, priority: 6 },
  { id: "multi", board: "caja", label: "MULTI", color: "gray", maxConcurrent: 1, sortOrder: 7, priority: 7 },
  // Phase 1: one person per station everywhere — including Nieves (no stacking).
  { id: "nieves", board: "caja", label: "Nieves", color: "teal", maxConcurrent: 1, sortOrder: 8, priority: null },
  { id: "mesero", board: "caja", label: "Mesero", color: "orange", maxConcurrent: 1, sortOrder: 9, priority: null },
  { id: "clean", board: "caja", label: "Limpieza / Clean", color: "cyan", maxConcurrent: 1, sortOrder: 10, priority: null },
];

/**
 * Cocina stations — SPEC §4.5
 * linea maxConcurrent=2 (optional config choice documented in DECISIONS).
 */
export const COCINA_STATIONS: StationSeed[] = [
  { id: "guia_abrir", board: "cocina", label: "Guia Abrir", color: "orange", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "linea", board: "cocina", label: "Linea", color: "red", maxConcurrent: 2, sortOrder: 1, priority: null },
  { id: "expo", board: "cocina", label: "Expo", color: "yellow", maxConcurrent: 1, sortOrder: 2, priority: null },
  { id: "prep", board: "cocina", label: "Prep", color: "green", maxConcurrent: 1, sortOrder: 3, priority: null },
  { id: "cerrar", board: "cocina", label: "Cerrar", color: "blue", maxConcurrent: 1, sortOrder: 4, priority: null },
  { id: "produccion", board: "cocina", label: "Produccion", color: "purple", maxConcurrent: 1, sortOrder: 5, priority: null },
  { id: "picar", board: "cocina", label: "Picar Carne", color: "brown", maxConcurrent: 1, sortOrder: 6, priority: null },
  { id: "dish", board: "cocina", label: "Dish", color: "gray", maxConcurrent: 1, sortOrder: 7, priority: null },
];

export const ALL_STATIONS: StationSeed[] = [...CAJA_STATIONS, ...COCINA_STATIONS];
