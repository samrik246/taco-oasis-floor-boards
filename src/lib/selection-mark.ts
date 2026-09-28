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
  brown: "border-amber-700",
  maroon: "border-red-900",
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
  brown: "bg-amber-700",
  maroon: "bg-red-900",
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
  brown: "bg-amber-50",
  maroon: "bg-red-50",
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
