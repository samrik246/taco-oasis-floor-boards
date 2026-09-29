import { levelWhenUnset } from "@/lib/abilities/column-default";

/** Four steps. A missing stored level is not a step until a caller resolves it. */
export type SelectionMark = "none" | "dashed" | "solid" | "filled";

/**
 * Border and wash tokens stay off `stationColorClass` and `stationSolidClass`,
 * so an open cell never wears a painted fill. The wash is lighter than a painted cell.
 */
const MARK_BORDER: Record<string, string> = {
  pink: "border-pink-600",
  green: "border-green-600",
  yellow: "border-yellow-600",
  purple: "border-purple-600",
  lime: "border-lime-600",
  blue: "border-blue-600",
  lavender: "border-violet-600",
  gray: "border-neutral-500",
  teal: "border-teal-600",
  orange: "border-orange-600",
  cyan: "border-cyan-600",
  red: "border-red-600",
  brown: "border-[#3e2723]",
  maroon: "border-red-900",
  gold: "border-amber-700",
  "light-red": "border-red-600",
  "light-brown": "border-[#8a5a2b]",
  "light-orange": "border-orange-600",
  "deep-orange": "border-orange-800",
  "light-green": "border-green-600",
  "dark-green": "border-green-900",
  "light-sky": "border-sky-600",
  sky: "border-sky-700",
  "dark-sky": "border-sky-800",
  "deep-sky": "border-sky-950",
  "light-pink": "border-pink-600",
  "dark-pink": "border-pink-800",
  violet: "border-violet-800",
  "gray-blue": "border-slate-500",
  white: "border-neutral-800",
};

const MARK_FILL: Record<string, string> = {
  pink: "bg-pink-600",
  green: "bg-green-600",
  yellow: "bg-yellow-600",
  purple: "bg-purple-600",
  lime: "bg-lime-600",
  blue: "bg-blue-600",
  lavender: "bg-violet-600",
  gray: "bg-neutral-500",
  teal: "bg-teal-600",
  orange: "bg-orange-600",
  cyan: "bg-cyan-600",
  red: "bg-red-600",
  brown: "bg-[#3e2723]",
  maroon: "bg-red-900",
  gold: "bg-amber-700",
  "light-red": "bg-red-600",
  "light-brown": "bg-[#c4956a]",
  "light-orange": "bg-orange-500",
  "deep-orange": "bg-orange-800",
  "light-green": "bg-green-600",
  "dark-green": "bg-green-950",
  "light-sky": "bg-sky-600",
  sky: "bg-sky-800",
  "dark-sky": "bg-sky-900",
  "deep-sky": "bg-[#020617]",
  "light-pink": "bg-pink-600",
  "dark-pink": "bg-pink-800",
  violet: "bg-violet-900",
  "gray-blue": "bg-slate-500",
  white: "bg-neutral-800",
};

const MARK_WASH: Record<string, string> = {
  pink: "bg-pink-50",
  green: "bg-green-50",
  yellow: "bg-yellow-50",
  purple: "bg-purple-50",
  lime: "bg-lime-50",
  blue: "bg-blue-50",
  lavender: "bg-violet-50",
  gray: "bg-neutral-50",
  teal: "bg-teal-50",
  orange: "bg-orange-50",
  cyan: "bg-cyan-50",
  red: "bg-red-50",
  brown: "bg-[#f3e6d8]",
  maroon: "bg-red-50",
  gold: "bg-amber-50",
  "light-red": "bg-red-50",
  "light-brown": "bg-[#f8efe3]",
  "light-orange": "bg-orange-50",
  "deep-orange": "bg-orange-100",
  "light-green": "bg-green-50",
  "dark-green": "bg-green-100",
  "light-sky": "bg-sky-50",
  sky: "bg-sky-50",
  "dark-sky": "bg-sky-100",
  "deep-sky": "bg-sky-200",
  "light-pink": "bg-pink-50",
  "dark-pink": "bg-pink-100",
  violet: "bg-violet-100",
  "gray-blue": "bg-slate-50",
  white: "bg-neutral-50",
};

const REST_CLASS = "border-solid border-neutral-300 bg-white text-neutral-700";

export function selectionMark(level: string | null | undefined): SelectionMark {
  if (level === "training") return "dashed";
  if (level === "ok") return "solid";
  if (level === "preferred") return "filled";
  return "none";
}

/**
 * No abilities array is none (manager payload).
 * A missing row follows the column default: forbidden is none, anything else is bien (solid).
 * A saved row uses its own level. A full saved row is not fuerte unless the level is preferred.
 */
export function markForStation(input: {
  abilities: readonly { stationId: string; level: string }[] | null | undefined;
  stationId: string;
  columnDefault?: string | null;
}): SelectionMark {
  if (!Array.isArray(input.abilities)) return "none";
  const row = input.abilities.find((ability) => ability.stationId === input.stationId);
  if (!row) {
    return selectionMark(levelWhenUnset(undefined, input.columnDefault) ?? "ok");
  }
  return selectionMark(row.level);
}

export function markBorderClass(color: string): string {
  return MARK_BORDER[color] ?? "border-neutral-600";
}

export function markFillClass(color: string): string {
  return MARK_FILL[color] ?? "bg-neutral-600";
}

/** Mid fills where white type fails. The word stays inside a fuerte cell. */
const FILLED_INK: Record<string, string> = {
  yellow: "text-neutral-950",
  lime: "text-neutral-950",
  orange: "text-neutral-950",
  cyan: "text-neutral-950",
  "light-orange": "text-neutral-950",
  "light-brown": "text-[#3f2a14]",
  "gray-blue": "text-neutral-950",
};

function markInkClass(color: string): string {
  return FILLED_INK[color] ?? "text-white";
}

const PLAIN_CELL = "border-solid border-neutral-300 bg-white text-neutral-800";

/**
 * Habilidades cell. Same border and fill tokens as SelectionMarkDot:
 * no is plain, poco is a dashed edge, bien is a solid edge, fuerte is the dot fill plus that edge.
 */
export function gridCellMarkClass(
  level: string,
  color: string,
): { className: string; mark: SelectionMark } {
  const mark = selectionMark(level);
  if (mark === "none") return { className: PLAIN_CELL, mark };
  const border = markBorderClass(color);
  if (mark === "dashed") {
    return { className: `border-dashed ${border} bg-white text-neutral-900`, mark };
  }
  if (mark === "filled") {
    return {
      className: `border-solid ${border} ${markFillClass(color)} ${markInkClass(color)}`,
      mark,
    };
  }
  return { className: `border-solid ${border} bg-white text-neutral-900`, mark };
}

export function openCellOutlineClass(input: {
  mode: "rest" | "manager" | "owner";
  mark: SelectionMark;
  color: string | null;
}): { className: string; outline: "rest" | "manager" | SelectionMark; wash: boolean } {
  if (input.mode === "manager") {
    const border = markBorderClass(input.color ?? "");
    return {
      className: `border-solid ${border} bg-white text-neutral-800`,
      outline: "manager",
      wash: false,
    };
  }
  if (input.mode !== "owner" || input.mark === "none") {
    return { className: REST_CLASS, outline: input.mode === "owner" ? "none" : "rest", wash: false };
  }
  const border = markBorderClass(input.color ?? "");
  if (input.mark === "dashed") {
    return {
      className: `border-dashed ${border} bg-white text-neutral-800`,
      outline: "dashed",
      wash: false,
    };
  }
  if (input.mark === "filled") {
    const wash = MARK_WASH[input.color ?? ""] ?? "bg-neutral-50";
    return {
      className: `border-solid ${border} ${wash} text-neutral-900`,
      outline: "filled",
      wash: true,
    };
  }
  return {
    className: `border-solid ${border} bg-white text-neutral-800`,
    outline: "solid",
    wash: false,
  };
}
