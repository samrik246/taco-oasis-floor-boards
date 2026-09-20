/**
 * Homework-style tarea catalogs per board (shared template).
 * Cashiers: one simplified daily list. Kitchen: starter set from kitchen-seed-content.
 */

export type TareaMode = "normal" | "backlog_when_slow";

export type TareaTemplateSeed = {
  id: string;
  code: string;
  label: string;
  mode: TareaMode;
  sortOrder: number;
  board: "caja" | "cocina";
  /** Warn when assigning to Green/cliente seats (manager can force). */
  lemonWarnOnGreens?: boolean;
  /** Prefer this seat when scoring suggestions (kitchen). */
  preferSeatId?: string;
  /** Soft-warn when this load station is slammed (manager can still assign). */
  warnIfLoadSlammed?: string;
};

export const CASHIER_TAREA_TEMPLATES: readonly TareaTemplateSeed[] = [
  {
    id: "positions",
    code: "POSITIONS",
    label: "POSITIONS (color board clear)",
    mode: "normal",
    sortOrder: 0,
    board: "caja",
  },
  {
    id: "desvenar_chiles",
    code: "DESVENAR_CHILES",
    label: "DESVENAR CHILES",
    mode: "backlog_when_slow",
    sortOrder: 1,
    board: "caja",
  },
  {
    id: "salsa",
    code: "SALSA",
    label: "SALSA",
    mode: "normal",
    sortOrder: 2,
    board: "caja",
  },
  {
    id: "crema_dulce",
    code: "CREMA_DULCE",
    label: "CREMA DULCE",
    mode: "normal",
    sortOrder: 3,
    board: "caja",
  },
  {
    id: "chunky_salsa",
    code: "CHUNKY_SALSA",
    label: "CHUNKY SALSA",
    mode: "normal",
    sortOrder: 4,
    board: "caja",
  },
  {
    id: "fire_salsa",
    code: "FIRE_SALSA",
    label: "FIRE SALSA",
    mode: "normal",
    sortOrder: 5,
    board: "caja",
  },
  {
    id: "red_baby_salsa",
    code: "RED_BABY_SALSA",
    label: "RED BABY SALSA",
    mode: "normal",
    sortOrder: 6,
    board: "caja",
  },
  {
    id: "green_baby_salsa",
    code: "GREEN_BABY_SALSA",
    label: "GREEN BABY SALSA",
    mode: "normal",
    sortOrder: 7,
    board: "caja",
  },
  {
    id: "ranch",
    code: "RANCH",
    label: "RANCH",
    mode: "normal",
    sortOrder: 8,
    board: "caja",
  },
  {
    id: "chipotle_ranch",
    code: "CHIPOTLE_RANCH",
    label: "CHIPOTLE RANCH",
    mode: "normal",
    sortOrder: 9,
    board: "caja",
  },
  {
    id: "caesar_dressing",
    code: "CAESAR_DRESSING",
    label: "CAESAR DRESSING",
    mode: "normal",
    sortOrder: 10,
    board: "caja",
  },
  {
    id: "italian_dressing",
    code: "ITALIAN_DRESSING",
    label: "ITALIAN DRESSING",
    mode: "normal",
    sortOrder: 11,
    board: "caja",
  },
  {
    id: "lemon",
    code: "LEMON_CUT_SQUEEZE",
    label: "LEMON CUT/SQUEEZE",
    mode: "normal",
    sortOrder: 12,
    board: "caja",
    lemonWarnOnGreens: true,
  },
  {
    id: "aguas_frescas",
    code: "AGUAS_FRESCAS",
    label: "AGUAS FRESCAS",
    mode: "normal",
    sortOrder: 13,
    board: "caja",
  },
  {
    id: "aguas_sublist",
    code: "AGUAS_SUBLIST",
    label: "Aguas! (sublist)",
    mode: "normal",
    sortOrder: 14,
    board: "caja",
  },
] as const;

/** Kitchen starter homework set — keys from kitchen-seed-content.md */
export const KITCHEN_TAREA_TEMPLATES: readonly TareaTemplateSeed[] = [
  {
    id: "prep_salsa_bar",
    code: "PREP_SALSA_BAR",
    label: "Prep salsa bar restock",
    mode: "normal",
    sortOrder: 0,
    board: "cocina",
  },
  {
    id: "wipe_line",
    code: "WIPE_LINE",
    label: "Wipe / sanitize line",
    mode: "backlog_when_slow",
    sortOrder: 1,
    board: "cocina",
  },
  {
    id: "restock_tortillas",
    code: "RESTOCK_TORTILLAS",
    label: "Restock tortillas",
    mode: "normal",
    sortOrder: 2,
    board: "cocina",
    preferSeatId: "tortilla",
  },
  {
    id: "restock_gloves",
    code: "RESTOCK_GLOVES",
    label: "Restock gloves / foil",
    mode: "normal",
    sortOrder: 3,
    board: "cocina",
  },
  {
    id: "deep_clean_fryer",
    code: "DEEP_CLEAN_FRYER",
    label: "Deep clean fryer area",
    mode: "normal",
    sortOrder: 4,
    board: "cocina",
    preferSeatId: "fryer",
    warnIfLoadSlammed: "fryer",
  },
  {
    id: "prep_birria",
    code: "PREP_BIRRIA",
    label: "Prep birria garnish/consomé",
    mode: "normal",
    sortOrder: 5,
    board: "cocina",
    preferSeatId: "birria",
  },
  {
    id: "stock_carne",
    code: "STOCK_CARNE",
    label: "Stock carne station",
    mode: "normal",
    sortOrder: 6,
    board: "cocina",
    preferSeatId: "carne",
  },
  {
    id: "trash_runs",
    code: "TRASH_RUNS",
    label: "Trash / cardboard runs",
    mode: "normal",
    sortOrder: 7,
    board: "cocina",
  },
  {
    id: "dish_assist",
    code: "DISH_ASSIST",
    label: "Dish assist",
    mode: "backlog_when_slow",
    sortOrder: 8,
    board: "cocina",
  },
] as const;

export const TAREA_STATUSES = ["working", "done"] as const;
export type TareaStatus = (typeof TAREA_STATUSES)[number];

export const GREEN_SEAT_IDS = ["green1", "green2"] as const;

export function tareaTemplateById(
  templateId: string,
): TareaTemplateSeed | undefined {
  return (
    CASHIER_TAREA_TEMPLATES.find((t) => t.id === templateId) ??
    KITCHEN_TAREA_TEMPLATES.find((t) => t.id === templateId)
  );
}

export function isLemonWarnTemplate(templateId: string): boolean {
  return tareaTemplateById(templateId)?.lemonWarnOnGreens === true;
}

export function isBacklogWhenSlow(templateId: string): boolean {
  return tareaTemplateById(templateId)?.mode === "backlog_when_slow";
}
