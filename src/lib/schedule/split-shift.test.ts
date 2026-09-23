import { describe, expect, it } from "vitest";
import { buildScheduleGrid, formatShiftWindowLabel } from "@/lib/schedule/build-schedule";
import { buildTimelineRows } from "@/components/board/timeline-rows";
import { availableShiftsForHour } from "@/components/board/board-helpers";
import type { ShiftDto } from "@/components/board/types";
import { chicagoDateTime } from "@/lib/time";

const D = "2030-04-01";
const iso = (clock: string) => chicagoDateTime(D, clock).toISOString();
const hourAssign = (stationId: string, from: string, to: string) => ({
  id: `a-${stationId}-${from}`,
  stationId,
  hourStart: iso(from),
  hourEnd: iso(to),
});

// One synthetic person with a split shift; one other person.
const employee = (id: string, externalId: string, firstName: string) => ({
  id,
  externalId,
  firstName,
  lastName: "Ejemplo",
  email: null,
  abilities: [],
});
const shifts: ShiftDto[] = [
  {
    id: "sh-late",
    date: D,
    startAt: iso("4:00 pm"),
    endAt: iso("8:00 pm"),
    sourcePosition: "Caja - Regular",
    board: "caja",
    employee: employee("e1", "0042", "Gala"),
    assignments: [hourAssign("green1", "5:00 pm", "6:00 pm")],
  },
  {
    id: "sh-early",
    date: D,
    startAt: iso("8:00 am"),
    endAt: iso("12:00 pm"),
    sourcePosition: "Caja - Regular",
    board: "caja",
    employee: employee("e1", "0042", "Gala"),
    assignments: [hourAssign("green2", "9:00 am", "10:00 am")],
  },
  {
    id: "sh-other",
    date: D,
    startAt: iso("10:00 am"),
    endAt: iso("2:00 pm"),
    sourcePosition: "Caja - Regular",
    board: "caja",
    employee: employee("e2", "42", "Hugo"),
    assignments: [],
  },
];
const stations = [
  { id: "green1", label: "Green 1", color: "green", sortOrder: 0 },
  { id: "green2", label: "Green 2", color: "green", sortOrder: 1 },
];

describe("A1: a split shift gets one row per shift", () => {
  it("Schedule: two rows for one person, distinct keys, each only inside its own hours", () => {
    for (const sort of ["name", "time", "position"] as const) {
      const grid = buildScheduleGrid({
        date: D,
        shifts,
        stations,
        mode: "all-day",
        sort,
        unassignedGroupLabel: "Unassigned",
      });
      const rows = grid.sections.flatMap((s) => s.rows);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.shiftId)).size).toBe(3);
      const early = rows.find((r) => r.shiftId === "sh-early")!;
      const late = rows.find((r) => r.shiftId === "sh-late")!;
      expect(early.externalId).toBe("0042");
      expect(late.externalId).toBe("0042");
      expect(early.name).toBe(late.name);
      expect(early.laterShiftOfPerson).toBe(false);
      expect(late.laterShiftOfPerson).toBe(true);
      expect(late.startLabel).toBe("4p");
      const onShift = (r: typeof early) =>
        [...r.hourStations.entries()].filter(([, v]) => v !== undefined).map(([h]) => h);
      expect(onShift(early)).toEqual([8, 9, 10, 11]);
      expect(onShift(late)).toEqual([16, 17, 18, 19]);
      expect(early.hourStations.get(9)).toBe("green2");
      expect(late.hourStations.get(17)).toBe("green1");
    }
  });

  it("Schedule name sort keeps one person's rows together, by start", () => {
    const grid = buildScheduleGrid({
      date: D,
      shifts,
      stations,
      mode: "all-day",
      sort: "name",
      unassignedGroupLabel: "Unassigned",
    });
    expect(grid.sections[0]!.rows.map((r) => r.shiftId)).toEqual([
      "sh-early",
      "sh-late",
      "sh-other",
    ]);
    // Headcount counts both seated shifts of the person in their own hours.
    expect(grid.headcount[grid.hours.indexOf(9)]).toBe(1);
    expect(grid.headcount[grid.hours.indexOf(17)]).toBe(1);
  });

  it("Timeline: two rows for one person, keyed by shift, each only inside its own hours", () => {
    const hours = Array.from({ length: 15 }, (_, i) => 7 + i);
    const rows = buildTimelineRows({
      shifts,
      date: D,
      hours,
      offLabel: "off",
      unassignedLabel: "open",
      stationLabelFor: (id) => id,
    });
    expect(rows.map((r) => r.shift.id)).toEqual(["sh-early", "sh-late", "sh-other"]);
    expect(rows.map((r) => r.laterShiftOfPerson)).toEqual([false, true, false]);
    const covered = (i: number) =>
      rows[i]!.cells.flatMap((c, idx) => (c.kind === "off" ? [] : [hours[idx]]));
    expect(covered(0)).toEqual([8, 9, 10, 11]);
    expect(covered(1)).toEqual([16, 17, 18, 19]);
    expect(rows[0]!.cells[hours.indexOf(9)]).toMatchObject({ kind: "seated", stationId: "green2" });
    expect(rows[1]!.cells[hours.indexOf(17)]).toMatchObject({ kind: "seated", stationId: "green1" });
  });
});

describe("shift window label shows Chicago minutes", () => {
  it("keeps whole hours compact and shows exact minutes otherwise", () => {
    expect(formatShiftWindowLabel(iso("7:00 am"), iso("3:00 pm"))).toBe("7a–3p");
    expect(formatShiftWindowLabel(iso("9:30 am"), iso("4:15 pm"))).toBe("9:30a–4:15p");
  });
});

describe("A6: a superseded shift shows only its assigned history hours, marked ended", () => {
  const superseded: ShiftDto = {
    id: "sh-old",
    date: D,
    startAt: iso("7:00 am"),
    endAt: iso("3:00 pm"),
    sourcePosition: "Caja - Regular",
    board: "caja",
    supersededAt: iso("12:30 pm"),
    employee: employee("e3", "5301", "Irma"),
    assignments: [hourAssign("green1", "9:00 am", "10:00 am")],
  };
  const replacement: ShiftDto = {
    ...superseded,
    id: "sh-new",
    startAt: iso("1:00 pm"),
    endAt: iso("8:00 pm"),
    supersededAt: null,
    assignments: [],
  };

  it("Schedule", () => {
    const grid = buildScheduleGrid({
      date: D,
      shifts: [superseded, replacement],
      stations,
      mode: "all-day",
      unassignedGroupLabel: "Unassigned",
    });
    const rows = grid.sections.flatMap((s) => s.rows);
    const old = rows.find((r) => r.shiftId === "sh-old")!;
    expect(old.ended).toBe(true);
    const onShift = [...old.hourStations.entries()].filter(([, v]) => v !== undefined);
    expect(onShift).toEqual([[9, "green1"]]);
    expect(rows.find((r) => r.shiftId === "sh-new")!.ended).toBe(false);
  });

  it("Timeline and the people list", () => {
    const hours = Array.from({ length: 15 }, (_, i) => 7 + i);
    const rows = buildTimelineRows({
      shifts: [superseded, replacement],
      date: D,
      hours,
      offLabel: "off",
      unassignedLabel: "open",
      stationLabelFor: (id) => id,
    });
    const old = rows.find((r) => r.shift.id === "sh-old")!;
    expect(old.ended).toBe(true);
    expect(old.cells.flatMap((c, i) => (c.kind === "off" ? [] : [hours[i]]))).toEqual([9]);
    expect(availableShiftsForHour([superseded, replacement], D, 14).map((s) => s.id)).toEqual(["sh-new"]);
    expect(availableShiftsForHour([superseded, replacement], D, 8)).toEqual([]);
  });
});

describe("fresh-review fixes around superseded rows", () => {
  const old: ShiftDto = {
    id: "sh-old2",
    date: D,
    startAt: iso("9:00 am"),
    endAt: iso("5:00 pm"),
    sourcePosition: "Caja - Regular",
    board: "caja",
    supersededAt: iso("10:15 am"),
    employee: employee("e4", "5302", "Jaime"),
    assignments: [hourAssign("green1", "10:00 am", "11:00 am")],
  };
  const replacement: ShiftDto = { ...old, id: "sh-new2", startAt: iso("10:00 am"), endAt: iso("6:00 pm"), supersededAt: null, assignments: [] };

  it("a person seated this hour on a superseded shift is not offered again on the replacement", () => {
    expect(availableShiftsForHour([old, replacement], D, 10)).toEqual([]);
    expect(availableShiftsForHour([old, replacement], D, 11).map((s) => s.id)).toEqual(["sh-new2"]);
  });

  it("an ended history row does not mark the live shift as a later shift", () => {
    const grid = buildScheduleGrid({ date: D, shifts: [old, replacement], stations, mode: "all-day", unassignedGroupLabel: "U" });
    const live = grid.sections.flatMap((s) => s.rows).find((r) => r.shiftId === "sh-new2")!;
    expect(live.laterShiftOfPerson).toBe(false);
    const rows = buildTimelineRows({
      shifts: [old, replacement],
      date: D,
      hours: [9, 10, 11],
      offLabel: "off",
      unassignedLabel: "open",
      stationLabelFor: (id) => id,
    });
    expect(rows.find((r) => r.shift.id === "sh-new2")!.laterShiftOfPerson).toBe(false);
  });
});
