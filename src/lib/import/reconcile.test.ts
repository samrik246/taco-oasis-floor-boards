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

function old(id: string, start: string, end: string, assignments: ExistingShift["assignments"] = []): ExistingShift {
  return {
    id,
    externalId: "6001",
    date: D,
    startAt: t(start),
    endAt: t(end),
    sourcePosition: "Caja - Regular",
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
