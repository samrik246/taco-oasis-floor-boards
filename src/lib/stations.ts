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
 * Cocina stations — Kitchen phase (provisional).
 * Six load/color seats: fryer, tortilla, birria, taquero, carne, prepa.
 * All maxConcurrent=1 (no doubles — same rule as caja).
 */
export const COCINA_STATIONS: StationSeed[] = [
  { id: "fryer", board: "cocina", label: "Fryer", color: "orange", maxConcurrent: 1, sortOrder: 0, priority: 1 },
  { id: "tortilla", board: "cocina", label: "Tortilla", color: "yellow", maxConcurrent: 1, sortOrder: 1, priority: 2 },
  { id: "birria", board: "cocina", label: "Birria", color: "red", maxConcurrent: 1, sortOrder: 2, priority: 3 },
  { id: "taquero", board: "cocina", label: "Taquero", color: "green", maxConcurrent: 1, sortOrder: 3, priority: 4 },
  { id: "carne", board: "cocina", label: "Carne", color: "brown", maxConcurrent: 1, sortOrder: 4, priority: 5 },
  { id: "prepa", board: "cocina", label: "Prepa", color: "cyan", maxConcurrent: 1, sortOrder: 5, priority: 6 },
];

/** Legacy cocina station ids removed in Kitchen phase (seed cleans these up). */
export const OBSOLETE_COCINA_STATION_IDS = [
  "guia_abrir",
  "linea",
  "expo",
  "prep",
  "cerrar",
  "produccion",
  "picar",
  "dish",
] as const;

export const ALL_STATIONS: StationSeed[] = [...CAJA_STATIONS, ...COCINA_STATIONS];
