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
  { id: "mana", board: "caja", label: "Manager", color: "pink", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "green1", board: "caja", label: "Green 1", color: "green", maxConcurrent: 1, sortOrder: 1, priority: 1 },
  { id: "yellow", board: "caja", label: "Yellow 1", color: "yellow", maxConcurrent: 1, sortOrder: 2, priority: 2 },
  { id: "yellow2", board: "caja", label: "Yellow 2", color: "yellow", maxConcurrent: 1, sortOrder: 2, priority: 2 },
  { id: "purple1", board: "caja", label: "Purple 1", color: "purple", maxConcurrent: 1, sortOrder: 3, priority: 3 },
  { id: "green2", board: "caja", label: "Green 2 / Jolt", color: "lime", maxConcurrent: 1, sortOrder: 4, priority: 4 },
  { id: "blue", board: "caja", label: "Blue / Outside", color: "blue", maxConcurrent: 1, sortOrder: 5, priority: 5 },
  { id: "purple2", board: "caja", label: "Purple 2 / Jolt", color: "lavender", maxConcurrent: 1, sortOrder: 6, priority: 6 },
  { id: "multi", board: "caja", label: "MULTI", color: "gray", maxConcurrent: 1, sortOrder: 7, priority: 7 },
  // Phase 1: one person per station everywhere — including Nieves (no stacking).
  { id: "nieves", board: "caja", label: "Nieves 1", color: "teal", maxConcurrent: 1, sortOrder: 8, priority: null },
  { id: "nieves2", board: "caja", label: "Nieves 2", color: "teal", maxConcurrent: 1, sortOrder: 8, priority: null },
  { id: "mesero", board: "caja", label: "Mesero", color: "orange", maxConcurrent: 1, sortOrder: 9, priority: null },
  { id: "clean", board: "caja", label: "Trapear Piso", color: "cyan", maxConcurrent: 1, sortOrder: 10, priority: null },
];

/**
 * Cocina stations from the numbered live board. The old unnumbered six seats
 * are deliberately absent so a future seed cannot recreate them.
 */
export const COCINA_STATIONS: StationSeed[] = [
  { id: "pdf_br2a", board: "cocina", label: "Birria 2", color: "orange", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "pdf_crne", board: "cocina", label: "Carne", color: "brown", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "pdf_pr3e", board: "cocina", label: "Preparación 3", color: "green", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "pdf_rlno", board: "cocina", label: "Rellenar", color: "lime", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "pdf_rngn", board: "cocina", label: "Relleno general", color: "gray", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "pdf_tf1r", board: "cocina", label: "Tortilla y freidora 1", color: "yellow", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "pdf_tsr2", board: "cocina", label: "Trastes 2 + Tareas", color: "gray", maxConcurrent: 1, sortOrder: 0, priority: null },
  { id: "pdf_guia", board: "cocina", label: "Guía", color: "orange", maxConcurrent: 1, sortOrder: 1, priority: null },
  { id: "pdf_pr1e", board: "cocina", label: "Preparación 1", color: "lime", maxConcurrent: 1, sortOrder: 2, priority: null },
  { id: "pdf_tq1r", board: "cocina", label: "Taquero 1 + Relleno", color: "pink", maxConcurrent: 1, sortOrder: 3, priority: null },
  { id: "pdf_tq2r", board: "cocina", label: "Taquero 2 + Relleno", color: "red", maxConcurrent: 1, sortOrder: 4, priority: null },
  { id: "pdf_tq3r", board: "cocina", label: "Taquero 3 - relleno + tareas", color: "maroon", maxConcurrent: 1, sortOrder: 4, priority: null },
  { id: "pdf_pr2e", board: "cocina", label: "Preparación 2", color: "green", maxConcurrent: 1, sortOrder: 5, priority: null },
  { id: "pdf_tf2r", board: "cocina", label: "Tortilla y freidora 2", color: "yellow", maxConcurrent: 1, sortOrder: 6, priority: null },
  { id: "pdf_pstl", board: "cocina", label: "Pasteles", color: "purple", maxConcurrent: 1, sortOrder: 7, priority: null },
  { id: "pdf_br1a", board: "cocina", label: "Birria 1", color: "brown", maxConcurrent: 1, sortOrder: 8, priority: null },
  { id: "pdf_tsrea", board: "cocina", label: "Trastes 1 + Tareas", color: "gray", maxConcurrent: 1, sortOrder: 9, priority: null },
  { id: "pdf_tsr3", board: "cocina", label: "Trastes 3 + Tareas", color: "gray", maxConcurrent: 1, sortOrder: 10, priority: null },
  { id: "pdf_tsr4", board: "cocina", label: "Trastes 4 + Tareas", color: "gray", maxConcurrent: 1, sortOrder: 11, priority: null },
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
