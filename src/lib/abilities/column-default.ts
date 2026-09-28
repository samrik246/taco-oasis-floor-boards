import type { AbilityLevel } from "@/lib/rules/types";

export const COLUMN_DEFAULT_LEVELS = ["ok", "forbidden"] as const;
export type ColumnDefaultLevel = (typeof COLUMN_DEFAULT_LEVELS)[number];

export function isColumnDefaultLevel(value: string): value is ColumnDefaultLevel {
  return value === "ok" || value === "forbidden";
}

/**
 * A stored row wins. A missing row uses the column default.
 * No default, or a default of ok, stays null so a reader that treats a
 * missing row as ok does not change.
 */
export function levelWhenUnset(
  stored: string | null | undefined,
  defaultLevel?: string | null,
): AbilityLevel | null {
  if (
    stored === "forbidden" ||
    stored === "training" ||
    stored === "ok" ||
    stored === "preferred"
  ) {
    return stored;
  }
  return defaultLevel === "forbidden" ? "forbidden" : null;
}
