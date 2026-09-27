import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { chicagoDateTime } from "@/lib/time";
import { paintAssignments, type PaintEdit } from "@/lib/assignments/paint";
import { PAINT_FAMILIES, type PaintFamily } from "@/lib/assignments/paint-families";

const prisma = new PrismaClient();
const date = "2030-09-25";
const employeeId = "paint-test-employee";
const otherEmployeeId = "paint-test-other";
const shiftId = "paint-test-shift";
const otherShiftId = "paint-test-other-shift";
const thirdEmployeeId = "paint-test-third";
const thirdShiftId = "paint-test-third-shift";
const stationA = "paint-test-green";
const stationB = "paint-test-blue";
const nieves1 = "nieves";
const nieves2 = "nieves2";
const createdFamilyStations = new Set<string>();
const startAt = chicagoDateTime(date, "7:30 am");
const endAt = chicagoDateTime(date, "10:15 am");
const familyBoards: { family: PaintFamily; board: "caja" | "cocina" }[] = [
  { family: "green", board: "caja" },
  { family: "purple", board: "caja" },
  { family: "nieves", board: "caja" },
  { family: "yellow", board: "caja" },
  { family: "preparacion", board: "cocina" },
  { family: "tortillaFreidora", board: "cocina" },
  { family: "taquero", board: "cocina" },
  { family: "birria", board: "cocina" },
  { family: "trastes", board: "cocina" },
];

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
    await prisma.positionMoveLog.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId, thirdEmployeeId] } } });
    await prisma.assignment.deleteMany({ where: { shiftId: { in: [shiftId, otherShiftId, thirdShiftId] } } });
    await prisma.shift.deleteMany({ where: { id: { in: [shiftId, otherShiftId, thirdShiftId] } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId, thirdEmployeeId] } } });
    await prisma.employee.deleteMany({ where: { id: { in: [employeeId, otherEmployeeId, thirdEmployeeId] } } });
    for (const [id, color] of [[stationA, "green"], [stationB, "blue"]]) {
      await prisma.station.upsert({
        where: { id },
        create: { id, board: "caja", label: id, color, maxConcurrent: 1, sortOrder: 90 },
        update: { board: "caja", maxConcurrent: 1 },
      });
    }
    for (const [id, order] of [[nieves1, 8], [nieves2, 9]] as const) {
      if (!await prisma.station.findUnique({ where: { id } })) createdFamilyStations.add(id);
      await prisma.station.upsert({
        where: { id },
        create: { id, board: "caja", label: `Nieves ${order - 7}`, color: "teal", maxConcurrent: 1, sortOrder: order },
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
    await prisma.positionMoveLog.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId, thirdEmployeeId] } } });
    await prisma.assignment.deleteMany({ where: { shiftId: { in: [shiftId, otherShiftId, thirdShiftId] } } });
    await prisma.shift.deleteMany({ where: { id: { in: [shiftId, otherShiftId, thirdShiftId] } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId, thirdEmployeeId] } } });
    await prisma.employee.deleteMany({ where: { id: { in: [employeeId, otherEmployeeId, thirdEmployeeId] } } });
    await prisma.station.deleteMany({ where: { id: { in: [stationA, stationB, ...createdFamilyStations] } } });
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

  it("keeps an existing number and chooses one free number across a painted range", async () => {
    await putAssignment("paint-test-anchor", employeeId, shiftId, nieves2, 7);
    const grouped = (hour: number, expected: PaintEdit["expected"] = null): PaintEdit => ({
      ...edit(hour, null, expected), family: "nieves",
    });
    const result = await paintAssignments({ board: "caja", date, edits: [
      grouped(7, { id: "paint-test-anchor", stationId: nieves2 }), grouped(8), grouped(9),
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result).toEqual({ ok: true, saved: 2 });
    const saved = await prisma.assignment.findMany({ where: { shiftId }, orderBy: { hourStart: "asc" } });
    expect(saved.map((row) => row.stationId)).toEqual([nieves2, nieves2, nieves2]);
    expect(saved[0]?.id).toBe("paint-test-anchor");
  });

  it("uses the first free number per hour when no single number fits the range", async () => {
    await putAssignment("paint-test-block-8", otherEmployeeId, otherShiftId, nieves1, 8);
    await putAssignment("paint-test-block-9", otherEmployeeId, otherShiftId, nieves2, 9);
    const result = await paintAssignments({ board: "caja", date, edits: [
      { ...edit(8, null), family: "nieves" }, { ...edit(9, null), family: "nieves" },
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result).toEqual({ ok: true, saved: 2 });
    const saved = await prisma.assignment.findMany({ where: { shiftId }, orderBy: { hourStart: "asc" } });
    expect(saved.map((row) => row.stationId)).toEqual([nieves2, nieves1]);
  });

  it("assigns two staged people to different numbers in the same hour", async () => {
    const result = await paintAssignments({ board: "caja", date, edits: [
      { ...edit(8, null), family: "nieves" },
      { ...edit(8, null), shiftId: otherShiftId,
        expectedShift: { startAt: startAt.toISOString(), endAt: endAt.toISOString(),
          employeeId: otherEmployeeId, sourcePosition: "Caja" }, family: "nieves" },
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result).toEqual({ ok: true, saved: 2 });
    const saved = await prisma.assignment.findMany({ where: { shiftId: { in: [shiftId, otherShiftId] } } });
    expect(saved.map((row) => row.stationId).sort()).toEqual([nieves1, nieves2]);
  });

  it("reserves concrete staged targets and refuses a full family without a partial save", async () => {
    const otherEdit = { ...edit(8, null), shiftId: otherShiftId,
      expectedShift: { startAt: startAt.toISOString(), endAt: endAt.toISOString(),
        employeeId: otherEmployeeId, sourcePosition: "Caja" } };
    const reserved = await paintAssignments({ board: "caja", date, edits: [
      { ...otherEdit, family: "nieves" }, edit(8, nieves1),
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(reserved).toEqual({ ok: true, saved: 2 });
    expect((await prisma.assignment.findFirstOrThrow({ where: { shiftId: otherShiftId } })).stationId).toBe(nieves2);
    await prisma.employee.create({ data: { id: thirdEmployeeId, externalId: thirdEmployeeId, firstName: "Paint", lastName: "Three" } });
    await prisma.shift.create({ data: { id: thirdShiftId, employeeId: thirdEmployeeId, board: "caja", date,
      sourcePosition: "Caja", startAt, endAt } });
    const result = await paintAssignments({ board: "caja", date, edits: [
      { ...edit(7, null), shiftId: thirdShiftId,
        expectedShift: { startAt: startAt.toISOString(), endAt: endAt.toISOString(),
          employeeId: thirdEmployeeId, sourcePosition: "Caja" }, family: "nieves" },
      { ...edit(8, null), shiftId: thirdShiftId,
        expectedShift: { startAt: startAt.toISOString(), endAt: endAt.toISOString(),
          employeeId: thirdEmployeeId, sourcePosition: "Caja" }, family: "nieves" },
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result).toEqual({ ok: false, status: 422, code: "STATION_FULL",
      message: "All numbered positions are occupied for this hour. Nothing was saved." });
    expect(await prisma.assignment.count({ where: { shiftId: thirdShiftId } })).toBe(0);
    expect((await prisma.assignment.findFirstOrThrow({ where: { shiftId: otherShiftId } })).stationId).toBe(nieves2);
  });

  it("rejects forbidden family ability and a stale numbered assignment", async () => {
    await prisma.employeeStationAbility.createMany({ data: [
      { employeeId, stationId: nieves1, level: "forbidden" },
      { employeeId, stationId: nieves2, level: "forbidden" },
    ] });
    const grouped = { ...edit(8, null), family: "nieves" as const };
    const denied = await paintAssignments({ board: "caja", date, edits: [grouped] }, chicagoDateTime(date, "6:00 am"));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("FORBIDDEN_ABILITY");
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId } });
    await putAssignment("paint-test-stale", employeeId, shiftId, nieves1, 8);
    const stale = await paintAssignments({ board: "caja", date, edits: [
      { ...grouped, expected: { id: "paint-test-stale", stationId: nieves2 } },
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("BOARD_CHANGED");
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: "paint-test-stale" } })).stationId).toBe(nieves1);
  });

  it("allocates Trastes from its four kitchen rows", async () => {
    const trastes = ["pdf_tsrea", "pdf_tsr2", "pdf_tsr3", "pdf_tsr4"];
    for (const [index, id] of trastes.entries()) {
      if (!await prisma.station.findUnique({ where: { id } })) createdFamilyStations.add(id);
      await prisma.station.upsert({ where: { id },
        create: { id, board: "cocina", label: `Trastes ${index + 1}`, color: "blue", maxConcurrent: 1, sortOrder: 80 + index },
        update: { board: "cocina", maxConcurrent: 1 },
      });
    }
    await prisma.shift.updateMany({ where: { id: { in: [shiftId, otherShiftId] } }, data: { board: "cocina" } });
    await putAssignment("paint-test-trastes-block", otherEmployeeId, otherShiftId, trastes[0]!, 8);
    const result = await paintAssignments({ board: "cocina", date, edits: [
      { ...edit(8, null), family: "trastes" }, { ...edit(9, null), family: "trastes" },
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result).toEqual({ ok: true, saved: 2 });
    const rows = await prisma.assignment.findMany({ where: { shiftId }, orderBy: { hourStart: "asc" } });
    expect(rows.map((row) => row.stationId)).toEqual([trastes[1], trastes[1]]);
  });

  it.each(familyBoards)("allocates $family only among its explicit $board members and honors an exact slot", async ({ family, board }) => {
    const ids = PAINT_FAMILIES[family];
    if (board === "cocina") {
      await prisma.shift.updateMany({ where: { id: { in: [shiftId, otherShiftId] } }, data: { board } });
    }
    for (const [index, id] of ids.entries()) {
      if (!await prisma.station.findUnique({ where: { id } })) createdFamilyStations.add(id);
      await prisma.station.upsert({ where: { id },
        create: { id, board, label: `${family} ${index + 1}`, color: index === 0 ? "green" : "lime",
          maxConcurrent: 1, sortOrder: 70 + index },
        update: { board, maxConcurrent: 1 },
      });
    }
    await putAssignment(`paint-test-${family}-occupied`, otherEmployeeId, otherShiftId, ids[0], 8);
    const result = await paintAssignments({ board, date, edits: [
      { ...edit(8, null), family }, edit(9, ids[0]),
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result).toEqual({ ok: true, saved: 2 });
    const saved = await prisma.assignment.findMany({ where: { shiftId }, orderBy: { hourStart: "asc" } });
    expect(saved.map((row) => row.stationId)).toEqual([ids[1], ids[0]]);
  });

  it("moves a forbidden current family slot to an eligible member without losing its number or color", async () => {
    for (const [id, color] of [["green1", "green"], ["green2", "lime"]]) {
      if (!await prisma.station.findUnique({ where: { id } })) createdFamilyStations.add(id);
      await prisma.station.upsert({ where: { id },
        create: { id, board: "caja", label: id === "green2" ? "Green 2 / Jolt" : "Green 1",
          color, maxConcurrent: 1, sortOrder: id === "green1" ? 1 : 2 },
        update: { board: "caja", color, maxConcurrent: 1 },
      });
    }
    await putAssignment("paint-test-green-current", employeeId, shiftId, "green1", 8);
    await prisma.employeeStationAbility.create({ data: { employeeId, stationId: "green1", level: "forbidden" } });
    const result = await paintAssignments({ board: "caja", date, edits: [
      { ...edit(8, null, { id: "paint-test-green-current", stationId: "green1" }), family: "green" },
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result).toEqual({ ok: true, saved: 1 });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: "paint-test-green-current" } })).stationId).toBe("green2");
    expect((await prisma.station.findUniqueOrThrow({ where: { id: "green2" } })).color).toBe("lime");
  });

  it("refuses an incomplete family as a conflict without saving another edited hour", async () => {
    if (!await prisma.station.findUnique({ where: { id: "green1" } })) createdFamilyStations.add("green1");
    if (!await prisma.station.findUnique({ where: { id: "green2" } })) createdFamilyStations.add("green2");
    await prisma.station.upsert({ where: { id: "green1" },
      create: { id: "green1", board: "caja", label: "Green 1", color: "green", maxConcurrent: 1, sortOrder: 1 },
      update: { board: "caja", maxConcurrent: 1 },
    });
    await prisma.station.upsert({ where: { id: "green2" },
      create: { id: "green2", board: "cocina", label: "Green 2 / Jolt", color: "lime", maxConcurrent: 1, sortOrder: 2 },
      update: { board: "cocina", maxConcurrent: 1 },
    });
    const result = await paintAssignments({ board: "caja", date, edits: [
      edit(7, stationA), { ...edit(8, null), family: "green" },
    ] }, chicagoDateTime(date, "6:00 am"));
    expect(result).toEqual({ ok: false, status: 409, code: "BOARD_CHANGED",
      message: "This position family changed. Refresh the board and review the painted hours." });
    expect(await prisma.assignment.count({ where: { shiftId } })).toBe(0);
  });
});
