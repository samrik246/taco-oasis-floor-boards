import { describe, expect, it } from "vitest";
import { planReconcile, type ExistingShift } from "@/lib/import/reconcile";
import type { ParsedShift } from "@/lib/parser/schedule-parser";
import { chicagoDateTime as at } from "@/lib/time";

const D = "2030-07-01";
const t = (clock: string) => at(D, clock);

function next(start: string, end: string, externalId = "6001", sourcePosition = "Caja - Regular"): ParsedShift {
  return {
    externalId,
    firstName: "Zoe",
    lastName: "Modelo",
    date: D,
    startAt: t(start),
    endAt: t(end),
    sourcePosition,
    board: "caja",
    stationHint: null,
  };
}

function old(id: string, start: string, end: string, assignments: ExistingShift["assignments"] = [],
             externalId = "6001", sourcePosition = "Caja - Regular"): ExistingShift {
  return {
    id,
    externalId,
    date: D,
    startAt: t(start),
    endAt: t(end),
    sourcePosition,
    board: "caja",
    assignments,
  };
}

const plan = (existing: ExistingShift[], shifts: ParsedShift[], now = at(D, "7:00 am")) =>
  planReconcile({ fingerprint: "f", shifts, existing, now });

describe("reconcile pairing", () => {
  it("pairs several shifts of one person in one position by greatest overlap", () => {
    const p = plan(
      [old("a", "8:00 am", "12:00 pm"), old("b", "4:00 pm", "8:00 pm")],
      [next("5:00 pm", "9:00 pm"), next("9:00 am", "1:00 pm")],
    );
    const changed = p.actions.filter((x) => x.kind === "changed");
    const pairs = changed
      .map((x) => (x.kind === "changed" ? [x.old.id, x.next.startAt.toISOString()] : []))
      .sort();
    expect(pairs).toEqual([
      ["a", t("9:00 am").toISOString()],
      ["b", t("5:00 pm").toISOString()],
    ]);
  });

  it("prefers an exact time match over a larger overlap", () => {
    const p = plan([old("a", "8:00 am", "12:00 pm")], [next("7:00 am", "1:00 pm"), next("8:00 am", "12:00 pm")]);
    expect(p.actions.map((x) => x.kind).sort()).toEqual(["added", "unchanged"]);
  });

  it("breaks equal overlap by earlier start, then existing shift id", () => {
    const p = plan([old("b", "8:00 am", "10:00 am"), old("a", "8:00 am", "10:00 am")], [next("9:00 am", "11:00 am")]);
    const paired = p.actions.find((x) => x.kind === "changed");
    expect(paired && paired.kind === "changed" && paired.old.id).toBe("a");
    expect(p.actions.filter((x) => x.kind === "removed").map((x) => x.kind === "removed" && x.old.id)).toEqual(["b"]);
  });

  it("back-to-back shifts of one person are not an overlap refusal", () => {
    const p = plan([], [next("8:00 am", "12:00 pm"), next("12:00 pm", "4:00 pm", "6001", "Caja - Nieves")]);
    expect(p.refusals).toEqual([]);
  });

  it("the digest changes when the removal set changes", () => {
    const hour = (h: string, h2: string) => ({ id: `x${h}`, stationId: "green1", hourStart: t(h), hourEnd: t(h2) });
    const a = plan([old("a", "8:00 am", "4:00 pm")], [next("8:00 am", "12:00 pm")]);
    const b = plan([old("a", "8:00 am", "4:00 pm", [hour("2:00 pm", "3:00 pm")])], [next("8:00 am", "12:00 pm")]);
    expect(a.digest).not.toBe(b.digest);
    const c = plan([old("a", "8:00 am", "4:00 pm", [hour("9:00 am", "10:00 am")])], [next("8:00 am", "12:00 pm")]);
    expect(c.digest).toBe(a.digest);
  });
});

describe("shift takeover matching", () => {
  const cell = (id: string, hour: string, end: string) => ({
    id, stationId: "purple1", hourStart: t(hour), hourEnd: t(end),
  });

  it("transfers only future cells for one exact incoming replacement", () => {
    const p = plan(
      [old("out", "8:00 am", "6:00 pm", [cell("worked", "11:00 am", "12:00 pm"), cell("future", "2:00 pm", "3:00 pm")])],
      [next("8:00 am", "6:00 pm", "6002")],
      t("12:30 pm"),
    );
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ kind: "takeover", old: { id: "out" },
      next: { externalId: "6002" }, removeAssignments: [{ id: "future" }] });
    expect(p.dates[0]).toMatchObject({ added: 1, removed: 1, assignmentsKept: 1,
      assignmentsToRemove: [], assignmentsToTransfer: [{ board: "caja", stationId: "purple1", hour: 14 }] });
  });

  it("leaves unrelated additions and removals separate", () => {
    for (const incoming of [
      next("9:00 am", "6:00 pm", "6002"),
      next("8:00 am", "6:00 pm", "6002", "Caja - Nieves"),
    ]) {
      const p = plan([old("out", "8:00 am", "6:00 pm", [cell("future", "2:00 pm", "3:00 pm")])],
        [incoming], t("12:30 pm"));
      expect(p.actions.map((a) => a.kind).sort()).toEqual(["added", "removed"]);
      expect(p.dates[0]!.assignmentsToTransfer).toEqual([]);
      expect(p.dates[0]!.assignmentsToRemove).toEqual([{ board: "caja", stationId: "purple1", hour: 14 }]);
    }
  });

  it("does not guess among multiple outgoing or incoming candidates", () => {
    const outgoing = [old("out-a", "8:00 am", "6:00 pm", [], "6001"),
      old("out-b", "8:00 am", "6:00 pm", [], "6003")];
    const incoming = [next("8:00 am", "6:00 pm", "6002"), next("8:00 am", "6:00 pm", "6004")];
    for (const [olds, news] of [
      [outgoing, incoming.slice(0, 1)],
      [outgoing.slice(0, 1), incoming],
    ] as const) {
      const p = plan(olds, news);
      expect(p.actions.some((a) => a.kind === "takeover")).toBe(false);
      expect(p.dates[0]!.assignmentsToTransfer).toEqual([]);
    }
  });
});

describe("pairing does not depend on file order (fresh review)", () => {
  it("one old shift, two new shifts with equal overlap: pairs with the earlier new start either way", () => {
    const hour = (h: string, h2: string) => ({ id: `x${h}`, stationId: "green1", hourStart: t(h), hourEnd: t(h2) });
    const existing = [old("a", "9:00 am", "9:00 pm", [hour("10:00 am", "11:00 am"), hour("6:00 pm", "7:00 pm")])];
    const early = next("9:00 am", "1:00 pm");
    const late = next("5:00 pm", "9:00 pm");
    const p1 = plan(existing, [early, late]);
    const p2 = plan(existing, [late, early]);
    expect(p1.digest).toBe(p2.digest);
    const changed = p1.actions.find((x) => x.kind === "changed");
    expect(changed && changed.kind === "changed" && changed.next.startAt.toISOString()).toBe(t("9:00 am").toISOString());
    expect(p1.dates[0]!.assignmentsToRemove).toEqual(p2.dates[0]!.assignmentsToRemove);
    expect(p1.dates[0]!.assignmentsToRemove.map((r) => r.hour)).toEqual([18]);
  });
});
