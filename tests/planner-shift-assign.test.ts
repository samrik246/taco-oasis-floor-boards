import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";
import { createEmployee } from "@/lib/employees/service";
import { createShiftAssignment, createAssignment } from "@/lib/assignments/service";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const DATE = "2026-09-20"; // a Sunday, unused by the fixture-driven test files

async function makeEmployee(externalId: string) {
  const created = await createEmployee({
    firstName: "Test",
    lastName: externalId,
    externalId,
  });
  if (!created.ok) throw new Error("setup: createEmployee failed");
  return created.employee.id;
}

async function makeShift(
  employeeId: string,
  startClock: string,
  endClock: string,
  board: "caja" | "cocina" = "caja",
) {
  return prisma.shift.create({
    data: {
      employeeId,
      date: DATE,
      startAt: chicagoDateTime(DATE, startClock),
      endAt: chicagoDateTime(DATE, endClock),
      sourcePosition: "Test",
      board,
    },
  });
}

// Planner A: whole-shift assign places one row per overlapping grid hour at
// one station, skipping (not failing) hours that are occupied, hours the
// person is already busy elsewhere, and hours already seating this exact
// person at this exact station.
describe("createShiftAssignment — Planner A", () => {
  beforeAll(async () => {
    for (const s of ALL_STATIONS) {
      await prisma.station.upsert({
        where: { id: s.id },
        create: {
          id: s.id,
          board: s.board,
          label: s.label,
          color: s.color,
          maxConcurrent: s.maxConcurrent,
          sortOrder: s.sortOrder,
          priority: s.priority,
        },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.assignment.deleteMany();
    await prisma.shift.deleteMany({ where: { date: DATE } });
    await prisma.employee.deleteMany({ where: { externalId: { startsWith: "shift-assign-" } } });
  });

  it("places one row for every on-the-hour grid hour of an 8 h shift", async () => {
    const employeeId = await makeEmployee("shift-assign-basic");
    const shift = await makeShift(employeeId, "10:00 am", "6:00 pm");
    const result = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "green1",
      date: DATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toEqual({
      placed: 8,
      alreadyThere: 0,
      stationOccupied: 0,
      personBusy: 0,
      superseded: 0,
    });
    const rows = await prisma.assignment.count({
      where: { stationId: "green1", employeeId },
    });
    expect(rows).toBe(8);
  });

  it("counts a partial-hour shift by minutes-overlap rows, not a rounded shift length", async () => {
    const employeeId = await makeEmployee("shift-assign-partial");
    const shift = await makeShift(employeeId, "10:30 am", "6:30 pm");
    const result = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "green1",
      date: DATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 10:30-18:30 overlaps grid hours 10..18 inclusive = 9 hours.
    expect(result.summary.placed).toBe(9);
  });

  it("clips to the grid: a shift outside 7-21 only places hours 7-21", async () => {
    const employeeId = await makeEmployee("shift-assign-clip");
    const shift = await makeShift(employeeId, "6:00 am", "10:30 pm");
    const result = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "green1",
      date: DATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.placed).toBe(15); // hours 7..21 inclusive, never 6 or 22
    const rows = await prisma.assignment.count({
      where: { stationId: "green1", employeeId },
    });
    expect(rows).toBe(15);
  });

  it("skips an hour the station already holds for someone else, and a hour this person is already busy elsewhere — without rolling back the rest", async () => {
    const employeeId = await makeEmployee("shift-assign-skip");
    const otherEmployeeId = await makeEmployee("shift-assign-skip-other");
    const otherShift = await makeShift(otherEmployeeId, "9:00 am", "5:00 pm");
    const shift = await makeShift(employeeId, "9:00 am", "5:00 pm"); // hours 9..16, 8 hours

    // Hour 11: green1 already taken by someone else.
    const stationTaken = await createAssignment({
      shiftId: otherShift.id,
      stationId: "green1",
      date: DATE,
      hour: 11,
    });
    expect(stationTaken.ok).toBe(true);

    // Hour 13: this person already seated at a different station.
    const busyElsewhere = await createAssignment({
      shiftId: shift.id,
      stationId: "purple1",
      date: DATE,
      hour: 13,
    });
    expect(busyElsewhere.ok).toBe(true);

    const result = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "green1",
      date: DATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.stationOccupied).toBe(1);
    expect(result.summary.personBusy).toBe(1);
    expect(result.summary.placed).toBe(6); // 8 hours - 1 station-taken - 1 person-busy
    const placedRows = await prisma.assignment.count({
      where: { stationId: "green1", employeeId },
    });
    expect(placedRows).toBe(6);
  });

  it("is idempotent: retapping the same shift+station reports alreadyThere, not a second write", async () => {
    const employeeId = await makeEmployee("shift-assign-retap");
    const shift = await makeShift(employeeId, "10:00 am", "2:00 pm"); // 4 hours
    const first = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "green1",
      date: DATE,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.summary.placed).toBe(4);

    const second = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "green1",
      date: DATE,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.summary).toEqual({
      placed: 0,
      alreadyThere: 4,
      stationOccupied: 0,
      personBusy: 0,
      superseded: 0,
    });
    const rows = await prisma.assignment.count({
      where: { stationId: "green1", employeeId },
    });
    expect(rows).toBe(4);
  });

  it("a forbidden ability writes nothing at all", async () => {
    const employeeId = await makeEmployee("shift-assign-forbidden");
    await prisma.employeeStationAbility.create({
      data: { employeeId, stationId: "green1", level: "forbidden" },
    });
    const shift = await makeShift(employeeId, "10:00 am", "2:00 pm");
    const result = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "green1",
      date: DATE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]!.code).toBe("FORBIDDEN_ABILITY");
    const rows = await prisma.assignment.count({ where: { employeeId } });
    expect(rows).toBe(0);
  });

  it("rejects a station on the other board and writes nothing", async () => {
    const employeeId = await makeEmployee("shift-assign-board-mismatch");
    const shift = await makeShift(employeeId, "10:00 am", "2:00 pm", "caja");
    const result = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "fryer", // cocina station
      date: DATE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]!.code).toBe("STATION_BOARD_MISMATCH");
  });

  it("gives a superseded shift's future hours their own count, distinct from stationOccupied", async () => {
    const employeeId = await makeEmployee("shift-assign-superseded");
    const shift = await makeShift(employeeId, "10:00 am", "2:00 pm"); // hours 10,11,12,13
    await prisma.shift.update({
      where: { id: shift.id },
      data: { supersededAt: chicagoDateTime(DATE, "9:00 am") },
    });
    const now = chicagoDateTime(DATE, "11:30 am"); // hours 10-11 started, 12-13 are future
    const result = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "green1",
      date: DATE,
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toEqual({
      placed: 2,
      alreadyThere: 0,
      stationOccupied: 0,
      personBusy: 0,
      superseded: 2,
    });
  });

  it("404s a nonexistent shift or station", async () => {
    const employeeId = await makeEmployee("shift-assign-404");
    const shift = await makeShift(employeeId, "10:00 am", "2:00 pm");
    const noShift = await createShiftAssignment({
      shiftId: "does-not-exist",
      stationId: "green1",
      date: DATE,
    });
    expect(noShift.ok).toBe(false);
    if (!noShift.ok) expect(noShift.status).toBe(404);

    const noStation = await createShiftAssignment({
      shiftId: shift.id,
      stationId: "does-not-exist",
      date: DATE,
    });
    expect(noStation.ok).toBe(false);
    if (!noStation.ok) expect(noStation.status).toBe(404);
  });
});
