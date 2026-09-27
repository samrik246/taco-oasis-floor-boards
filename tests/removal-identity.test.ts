import { describe, expect, it } from "vitest";
import { planRemovalIdentity, type RemovedOccurrence } from "@/lib/import/removal-identity";
import type { ExistingShift, PlanAction } from "@/lib/import/reconcile";
import type { ParsedShift } from "@/lib/parser/schedule-parser";

const date = "2030-06-03";
const at = (hour: number) => new Date(`2030-06-03T${String(hour).padStart(2, "0")}:00:00-05:00`);
const old = (id: string, start: number, end: number): ExistingShift => ({
  id, externalId: "5201", date, board: "caja", sourcePosition: "Caja - Regular",
  startAt: at(start), endAt: at(end), assignments: [],
});
const next = (start: number, end: number): ParsedShift => ({
  externalId: "5201", firstName: "Abril", lastName: "Ejemplo", date,
  board: "caja", sourcePosition: "Caja - Regular", stationHint: null,
  startAt: at(start), endAt: at(end),
});
const removed = (shift: ExistingShift, shiftId: string | null = shift.id): RemovedOccurrence => ({
  id: "override-1", shiftId, revision: 1,
  externalId: shift.externalId, date, board: shift.board,
  sourcePosition: shift.sourcePosition, startAt: shift.startAt, endAt: shift.endAt,
});

describe("removed occurrence identity on schedule re-import", () => {
  it("refuses the zero-overlap split shift even when the reconciler retained its local id", () => {
    const morning = old("first", 8, 10);
    const afternoon = old("second", 14, 16);
    const firstNew = next(10, 12);
    const secondNew = next(16, 18);
    const actions: PlanAction[] = [
      { kind: "changed", old: morning, next: firstNew, removeAssignments: [] },
      { kind: "changed", old: afternoon, next: secondNew, removeAssignments: [] },
    ];
    const result = planRemovalIdentity({ removals: [removed(morning)],
      existing: [morning, afternoon], incoming: [firstNew, secondNew], actions });
    expect(result.decisions).toEqual([]);
    expect(result.refusals).toMatchObject([{ code: "REMOVAL_IDENTITY", date }]);
  });

  it("retains removal for one uniquely overlapping source change", () => {
    const before = old("first", 8, 12);
    const after = next(9, 13);
    const result = planRemovalIdentity({ removals: [removed(before)], existing: [before],
      incoming: [after], actions: [{ kind: "changed", old: before, next: after,
        removeAssignments: [] }] });
    expect(result.refusals).toEqual([]);
    expect(result.decisions).toEqual([{ overrideId: "override-1", action: "changed", next: after }]);
  });

  it("refuses a changed window with two plausible old occurrences", () => {
    const first = old("first", 8, 12);
    const second = old("second", 10, 14);
    const after = next(9, 13);
    const result = planRemovalIdentity({ removals: [removed(first)],
      existing: [first, second], incoming: [after],
      actions: [{ kind: "changed", old: first, next: after, removeAssignments: [] },
        { kind: "removed", old: second, removeAssignments: [] }] });
    expect(result.refusals).toMatchObject([{ code: "REMOVAL_IDENTITY" }]);
  });

  it("relinks one exact tombstone and refuses competing tombstones", () => {
    const before = old("first", 8, 12);
    const after = next(8, 12);
    const tombstone = removed(before, null);
    const actions: PlanAction[] = [{ kind: "added", next: after }];
    const unique = planRemovalIdentity({ removals: [tombstone], existing: [],
      incoming: [after], actions });
    expect(unique.decisions).toEqual([{ overrideId: "override-1", action: "relink", next: after }]);
    const ambiguous = planRemovalIdentity({ removals: [tombstone, { ...tombstone, id: "override-2" }],
      existing: [], incoming: [after], actions });
    expect(ambiguous.refusals).toHaveLength(2);
  });
});
