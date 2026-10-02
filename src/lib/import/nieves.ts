import type { ParseResult } from "@/lib/parser/schedule-parser";
import type { ReconcilePlan } from "./reconcile";

export const NIEVES_POSITION = "Caja - Nieves";
export type FixedWindow = { startMs: number; endMs: number };
export type FixedPlacementSkip = {
  shiftId: string; hour: number; reason: string;
  employeeId?: string; workerName?: string; date?: string; startAt?: string; endAt?: string;
};

/** Only the default mapping expands. Cleared/remapped choices stay explicit. */
export function nievesSeats(mappedStationId: string): readonly string[] {
  return mappedStationId === "nieves" ? ["nieves", "nieves2"] : [mappedStationId];
}

export function subtractWindows(window: FixedWindow, occupied: readonly FixedWindow[]): FixedWindow[] {
  let remaining = [window];
  for (const part of occupied) remaining = remaining.flatMap(row => {
    if (part.startMs >= row.endMs || part.endMs <= row.startMs) return [row];
    return [
      ...(row.startMs < part.startMs ? [{ startMs: row.startMs, endMs: part.startMs }] : []),
      ...(row.endMs > part.endMs ? [{ startMs: part.endMs, endMs: row.endMs }] : []),
    ];
  });
  return remaining.filter(row => row.startMs < row.endMs);
}

/** A blank in an old source window is not evidence of an import omission. */
export function introducedNievesWindows(
  plan: ReconcilePlan,
  created: ReadonlyMap<ParseResult["shifts"][number], { id: string }>,
): Map<string, FixedWindow[]> {
  const windows = new Map<string, FixedWindow[]>();
  for (const action of plan.actions) {
    if (action.kind === "removed") continue;
    if (action.kind === "unchanged") { windows.set(action.old.id, []); continue; }
    const id = created.get(action.next)?.id ?? ("old" in action ? action.old.id : null);
    if (!id) throw new Error("Missing imported shift identity");
    const next = { startMs: +action.next.startAt, endMs: +action.next.endAt };
    windows.set(id, "old" in action
      ? subtractWindows(next, [{ startMs: +action.old.startAt, endMs: +action.old.endAt }])
      : [next]);
  }
  return windows;
}
