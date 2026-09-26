import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { chicagoDateTime } from "@/lib/time";
import { paintAssignments, type PaintEdit } from "@/lib/assignments/paint";

const prisma = new PrismaClient();
const date = "2030-09-25";
const employeeId = "paint-test-employee";
const otherEmployeeId = "paint-test-other";
const shiftId = "paint-test-shift";
const otherShiftId = "paint-test-other-shift";
const stationA = "paint-test-green";
const stationB = "paint-test-blue";
const startAt = chicagoDateTime(date, "7:30 am");
const endAt = chicagoDateTime(date, "10:15 am");

function edit(hour: number, stationId: string | null, expected: PaintEdit["expected"] = null): PaintEdit {
  return {
    shiftId,
    hour,
    expectedShift: { startAt: startAt.toISOString(), endAt: endAt.toISOString(), employeeId, sourcePosition: "Caja" },
    expected,
    stationId,
  };
}

async function putAssignment(id: string, person: string, shift: string, station: string, hour: number) {
  return prisma.assignment.create({
    data: {
      id,
      shiftId: shift,
      employeeId: person,
      stationId: station,
      hourStart: chicagoHourStart(date, hour),
      hourEnd: chicagoHourEnd(date, hour),
    },
  });
}

describe("manager color paint transaction", () => {
  beforeEach(async () => {
    await prisma.positionMoveLog.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId] } } });
    await prisma.assignment.deleteMany({ where: { shiftId: { in: [shiftId, otherShiftId] } } });
    await prisma.shift.deleteMany({ where: { id: { in: [shiftId, otherShiftId] } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId] } } });
    await prisma.employee.deleteMany({ where: { id: { in: [employeeId, otherEmployeeId] } } });
    for (const [id, color] of [[stationA, "green"], [stationB, "blue"]]) {
      await prisma.station.upsert({
        where: { id },
        create: { id, board: "caja", label: id, color, maxConcurrent: 1, sortOrder: 90 },
        update: { board: "caja", maxConcurrent: 1 },
      });
    }
    await prisma.employee.createMany({ data: [
      { id: employeeId, externalId: employeeId, firstName: "Paint", lastName: "One" },
      { id: otherEmployeeId, externalId: otherEmployeeId, firstName: "Paint", lastName: "Two" },
    ] });
    await prisma.shift.createMany({ data: [
      { id: shiftId, employeeId, board: "caja", date, sourcePosition: "Caja", startAt, endAt },
      { id: otherShiftId, employeeId: otherEmployeeId, board: "caja", date, sourcePosition: "Caja", startAt, endAt },
    ] });
  });

  afterAll(async () => {
    await prisma.positionMoveLog.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId] } } });
    await prisma.assignment.deleteMany({ where: { shiftId: { in: [shiftId, otherShiftId] } } });
    await prisma.shift.deleteMany({ where: { id: { in: [shiftId, otherShiftId] } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId] } } });
    await prisma.employee.deleteMany({ where: { id: { in: [employeeId, otherEmployeeId] } } });
    await prisma.station.deleteMany({ where: { id: { in: [stationA, stationB] } } });
    await prisma.$disconnect();
  });

  it("accepts a partial first hour but saves none when another painted station is full", async () => {
    await putAssignment("paint-test-occupied", otherEmployeeId, otherShiftId, stationA, 8);
    const result = await paintAssignments({ board: "caja", date, edits: [
      edit(7, stationB),
      edit(8, stationA),
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("STATION_FULL");
    expect(await prisma.assignment.count({ where: { shiftId } })).toBe(0);
  });

  it("saves both hours atomically and rejects a changed assignment value", async () => {
    const first = await paintAssignments({ board: "caja", date, edits: [
      edit(7, stationA), edit(8, stationA),
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(first).toEqual({ ok: true, saved: 2 });
    const existing = await prisma.assignment.findFirstOrThrow({ where: { shiftId, hourStart: chicagoHourStart(date, 8) } });
    await prisma.assignment.update({ where: { id: existing.id }, data: { stationId: stationB } });
    const stale = await paintAssignments({ board: "caja", date, edits: [
      edit(8, null, { id: existing.id, stationId: stationA }),
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("BOARD_CHANGED");
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: existing.id } })).stationId).toBe(stationB);
  });

  it("rejects a WIW shift-hour update that retains the same shift id", async () => {
    await prisma.shift.update({ where: { id: shiftId }, data: { startAt: chicagoDateTime(date, "8:30 am") } });
    const result = await paintAssignments({ board: "caja", date, edits: [edit(8, stationA)] }, chicagoDateTime(date, "6:00 am"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BOARD_CHANGED");
    expect(await prisma.assignment.count({ where: { shiftId } })).toBe(0);
  });

  it("requires and logs a move reason for a current cell, but not a future erase", async () => {
    await putAssignment("paint-test-current", employeeId, shiftId, stationA, 8);
    const change = edit(8, stationB, { id: "paint-test-current", stationId: stationA });
    const now = chicagoDateTime(date, "8:15 am");
    const refused = await paintAssignments({ board: "caja", date, edits: [change] }, now);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("MOVE_REASON_REQUIRED");
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: "paint-test-current" } })).stationId).toBe(stationA);
    const changed = await paintAssignments({ board: "caja", date, edits: [{ ...change, reason: "Other" }] }, now);
    expect(changed).toEqual({ ok: true, saved: 1 });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: "paint-test-current" } })).stationId).toBe(stationB);
    expect(await prisma.positionMoveLog.count({ where: { employeeId } })).toBe(1);

    await putAssignment("paint-test-future", employeeId, shiftId, stationA, 9);
    const erased = await paintAssignments({ board: "caja", date, edits: [
      edit(9, null, { id: "paint-test-future", stationId: stationA }),
    ] }, now);
    expect(erased).toEqual({ ok: true, saved: 1 });
    expect(await prisma.assignment.findUnique({ where: { id: "paint-test-future" } })).toBeNull();
    expect(await prisma.positionMoveLog.count({ where: { employeeId } })).toBe(1);
  });
});
