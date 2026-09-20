/**
 * Simplified daily cashiers tareas list (homework-style).
 * One list every day — not Wed/Thu Jolt quirks. Jolt stays for time-critical routines.
 */

export type TareaMode = "normal" | "backlog_when_slow";

export type TareaTemplateSeed = {
  id: string;
  code: string;
  label: string;
  mode: TareaMode;
  sortOrder: number;
  /** Warn when assigning to Green/cliente seats (manager can force). */
  lemonWarnOnGreens?: boolean;
};

export const CASHIER_TAREA_TEMPLATES: readonly TareaTemplateSeed[] = [
  {
    id: "positions",
    code: "POSITIONS",
    label: "POSITIONS (color board clear)",
    mode: "normal",
    sortOrder: 0,
  },
  {
    id: "desvenar_chiles",
    code: "DESVENAR_CHILES",
    label: "DESVENAR CHILES",
    mode: "backlog_when_slow",
    sortOrder: 1,
  },
  {
    id: "salsa",
    code: "SALSA",
    label: "SALSA",
    mode: "normal",
    sortOrder: 2,
  },
  {
    id: "crema_dulce",
    code: "CREMA_DULCE",
    label: "CREMA DULCE",
    mode: "normal",
    sortOrder: 3,
  },
  {
    id: "chunky_salsa",
    code: "CHUNKY_SALSA",
    label: "CHUNKY SALSA",
    mode: "normal",
    sortOrder: 4,
  },
  {
    id: "fire_salsa",
    code: "FIRE_SALSA",
    label: "FIRE SALSA",
    mode: "normal",
    sortOrder: 5,
  },
  {
    id: "red_baby_salsa",
    code: "RED_BABY_SALSA",
    label: "RED BABY SALSA",
    mode: "normal",
    sortOrder: 6,
  },
  {
    id: "green_baby_salsa",
    code: "GREEN_BABY_SALSA",
    label: "GREEN BABY SALSA",
    mode: "normal",
    sortOrder: 7,
  },
  {
    id: "ranch",
    code: "RANCH",
    label: "RANCH",
    mode: "normal",
    sortOrder: 8,
  },
  {
    id: "chipotle_ranch",
    code: "CHIPOTLE_RANCH",
    label: "CHIPOTLE RANCH",
    mode: "normal",
    sortOrder: 9,
  },
  {
    id: "caesar_dressing",
    code: "CAESAR_DRESSING",
    label: "CAESAR DRESSING",
    mode: "normal",
    sortOrder: 10,
  },
  {
    id: "italian_dressing",
    code: "ITALIAN_DRESSING",
    label: "ITALIAN DRESSING",
    mode: "normal",
    sortOrder: 11,
  },
  {
    id: "lemon",
    code: "LEMON_CUT_SQUEEZE",
    label: "LEMON CUT/SQUEEZE",
    mode: "normal",
    sortOrder: 12,
    lemonWarnOnGreens: true,
  },
  {
    id: "aguas_frescas",
    code: "AGUAS_FRESCAS",
    label: "AGUAS FRESCAS",
    mode: "normal",
    sortOrder: 13,
  },
  {
    id: "aguas_sublist",
    code: "AGUAS_SUBLIST",
    label: "Aguas! (sublist)",
    mode: "normal",
    sortOrder: 14,
  },
] as const;

export const TAREA_STATUSES = ["working", "done"] as const;
export type TareaStatus = (typeof TAREA_STATUSES)[number];

export const GREEN_SEAT_IDS = ["green1", "green2"] as const;

export function isLemonWarnTemplate(templateId: string): boolean {
  return (
    CASHIER_TAREA_TEMPLATES.find((t) => t.id === templateId)?.lemonWarnOnGreens ===
    true
  );
}

export function isBacklogWhenSlow(templateId: string): boolean {
  return (
    CASHIER_TAREA_TEMPLATES.find((t) => t.id === templateId)?.mode ===
    "backlog_when_slow"
  );
}
