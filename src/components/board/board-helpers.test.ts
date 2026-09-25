import { describe, expect, it } from "vitest";
import { shiftsForWholeDay } from "./board-helpers";
import type { ShiftDto } from "./types";

function shift(over: Partial<ShiftDto> & { id: string }): ShiftDto {
  return {
    date: "2026-09-20",
    startAt: "2026-09-20T15:00:00.000Z",
    endAt: "2026-09-20T19:00:00.000Z",
    sourcePosition: "Caja - Regular",
    board: "caja",
    supersededAt: null,
    employee: {
      id: over.employee?.id ?? over.id,
      externalId: over.employee?.externalId ?? over.id,
      firstName: "A",
      lastName: "B",
      email: null,
      abilities: [],
    },
    assignments: [],
    ...over,
  };
}

describe("shiftsForWholeDay (Planner A Turno completo list)", () => {
  it("lists both halves of a split day, not just the one covering some hour", () => {
    const morning = shift({ id: "s1", startAt: "2026-09-20T15:00:00.000Z", endAt: "2026-09-20T19:00:00.000Z" });
    const evening = shift({ id: "s2", startAt: "2026-09-20T23:00:00.000Z", endAt: "2026-09-21T03:00:00.000Z" });
    const list = shiftsForWholeDay([morning, evening]);
    expect(list.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("keeps a shift whose person is already seated some hour — whole-shift placement skips only that hour", () => {
    const seated = shift({
      id: "s1",
      assignments: [{ id: "a1", stationId: "green1", hourStart: "2026-09-20T17:00:00.000Z", hourEnd: "2026-09-20T18:00:00.000Z" }],
    });
    const list = shiftsForWholeDay([seated]);
    expect(list.map((s) => s.id)).toEqual(["s1"]);
  });

  it("excludes a superseded shift", () => {
    const active = shift({ id: "s1" });
    const superseded = shift({ id: "s2", supersededAt: "2026-09-20T12:00:00.000Z" });
    const list = shiftsForWholeDay([active, superseded]);
    expect(list.map((s) => s.id)).toEqual(["s1"]);
  });

  it("sorts by display name", () => {
    const zed = shift({ id: "s1", employee: { id: "e1", externalId: "e1", firstName: "Zed", lastName: "Z", email: null, abilities: [] } });
    const amy = shift({ id: "s2", employee: { id: "e2", externalId: "e2", firstName: "Amy", lastName: "A", email: null, abilities: [] } });
    const list = shiftsForWholeDay([zed, amy]);
    expect(list.map((s) => s.id)).toEqual(["s2", "s1"]);
  });
});
