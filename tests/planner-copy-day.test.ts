import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";
import { createEmployee } from "@/lib/employees/service";
import { createAssignment, copyDayAssignments } from "@/lib/assignments/service";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const SOURCE_DATE = "2026-09-20";
const TARGET_DATE = "2026-09-21";

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
  date: string,
  startClock: string,
  endClock: string,
  board: "caja" | "cocina" = "caja",
) {
  return prisma.shift.create({
    data: {
      employeeId,
      date,
      startAt: chicagoDateTime(date, startClock),
      endAt: chicagoDateTime(date, endClock),
      sourcePosition: "Test",
      board,
    },
  });
}

// Planner B: copy source-day placements onto the target day for people with
// an overlapping shift there, at the same station. Never overwrites.
describe("copyDayAssignments — Planner B", () => {
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
    await prisma.shift.deleteMany({ where: { date: { in: [SOURCE_DATE, TARGET_DATE] } } });
    await prisma.employee.deleteMany({ where: { externalId: { startsWith: "copy-day-" } } });
  });

  it("copies a placement to the same station and hour on the target day", async () => {
    const employeeId = await makeEmployee("copy-day-basic");
    const sourceShift = await makeShift(employeeId, SOURCE_DATE, "10:00 am", "2:00 pm");
    await makeShift(employeeId, TARGET_DATE, "10:00 am", "2:00 pm");
    const seated = await createAssignment({
      shiftId: sourceShift.id,
      stationId: "green1",
      date: SOURCE_DATE,
      hour: 11,
    });
    expect(seated.ok).toBe(true);

    const result = await copyDayAssignments({
      board: "caja",
      sourceDate: SOURCE_DATE,
      targetDate: TARGET_DATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toEqual({
      copied: 1,
      noShift: 0,
      occupied: 0,
      alreadyThere: 0,
      forbidden: 0,
    });
    const targetRow = await prisma.assignment.findFirst({
      where: { stationId: "green1", employeeId, hourStart: chicagoDateTime(TARGET_DATE, "11:00 am") },
    });
    expect(targetRow).not.toBeNull();
  });

  it("never overwrites — a target hour already held by someone else stays byte for byte", async () => {
    const employeeId = await makeEmployee("copy-day-overwrite-a");
    const otherId = await makeEmployee("copy-day-overwrite-b");
    const sourceShift = await makeShift(employeeId, SOURCE_DATE, "10:00 am", "2:00 pm");
    await makeShift(employeeId, TARGET_DATE, "10:00 am", "2:00 pm");
    const otherTargetShift = await makeShift(otherId, TARGET_DATE, "10:00 am", "2:00 pm");
    await createAssignment({ shiftId: sourceShift.id, stationId: "green1", date: SOURCE_DATE, hour: 11 });
    const existingTarget = await createAssignment({
      shiftId: otherTargetShift.id,
      stationId: "green1",
      date: TARGET_DATE,
      hour: 11,
    });
    expect(existingTarget.ok).toBe(true);
    if (!existingTarget.ok) return;
    const beforeId = existingTarget.assignment.id;

    const result = await copyDayAssignments({
      board: "caja",
      sourceDate: SOURCE_DATE,
      targetDate: TARGET_DATE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.occupied).toBe(1);
    expect(result.summary.copied).toBe(0);

    // Mutation target: the existing row is untouched — same id, same employee.
    const stillThere = await prisma.assignment.findUnique({ where: { id: beforeId } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.employeeId).toBe(otherId);
    const rowsAtThatHour = await prisma.assignment.count({
      where: { stationId: "green1", hourStart: chicagoDateTime(TARGET_DATE, "11:00 am") },
    });
    expect(rowsAtThatHour).toBe(1);
  });

  it("re-running the copy reports alreadyThere, not a duplicate row", async () => {
    const employeeId = await makeEmployee("copy-day-retap");
    const sourceShift = await makeShift(employeeId, SOURCE_DATE, "10:00 am", "2:00 pm");
    await makeShift(employeeId, TARGET_DATE, "10:00 am", "2:00 pm");
    await createAssignment({ shiftId: sourceShift.id, stationId: "green1", date: SOURCE_DATE, hour: 11 });

    const first = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: TARGET_DATE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.summary.copied).toBe(1);

    const second = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: TARGET_DATE });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.summary.alreadyThere).toBe(1);
    expect(second.summary.copied).toBe(0);
    const targetRows = await prisma.assignment.count({
      where: { stationId: "green1", employeeId, hourStart: chicagoDateTime(TARGET_DATE, "11:00 am") },
    });
    expect(targetRows).toBe(1);
  });

  it("counts an hour with no overlapping shift on the target day as noShift", async () => {
    const employeeId = await makeEmployee("copy-day-noshift");
    const sourceShift = await makeShift(employeeId, SOURCE_DATE, "10:00 am", "2:00 pm");
    // No shift created for this employee on TARGET_DATE.
    await createAssignment({ shiftId: sourceShift.id, stationId: "green1", date: SOURCE_DATE, hour: 11 });

    const result = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: TARGET_DATE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.noShift).toBe(1);
    expect(result.summary.copied).toBe(0);
  });

  it("a forbidden station on the target day writes nothing and counts separately", async () => {
    const employeeId = await makeEmployee("copy-day-forbidden");
    const sourceShift = await makeShift(employeeId, SOURCE_DATE, "10:00 am", "2:00 pm");
    await makeShift(employeeId, TARGET_DATE, "10:00 am", "2:00 pm");
    // Seat them on the source day first — the ability restriction below is
    // meant to block the copy onto the target day, not the source seating.
    await createAssignment({ shiftId: sourceShift.id, stationId: "green1", date: SOURCE_DATE, hour: 11 });
    await prisma.employeeStationAbility.create({
      data: { employeeId, stationId: "green1", level: "forbidden" },
    });

    const result = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: TARGET_DATE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.forbidden).toBe(1);
    expect(result.summary.copied).toBe(0);
    expect(result.summary.occupied).toBe(0);
    const targetRows = await prisma.assignment.count({
      where: { employeeId, stationId: "green1", hourStart: chicagoDateTime(TARGET_DATE, "11:00 am") },
    });
    expect(targetRows).toBe(0);
  });

  it("scopes the source read to the given board only", async () => {
    const cocinaEmployeeId = await makeEmployee("copy-day-cocina");
    const cocinaShift = await makeShift(cocinaEmployeeId, SOURCE_DATE, "10:00 am", "2:00 pm", "cocina");
    await makeShift(cocinaEmployeeId, TARGET_DATE, "10:00 am", "2:00 pm", "cocina");
    await createAssignment({ shiftId: cocinaShift.id, stationId: "fryer", date: SOURCE_DATE, hour: 11 });

    const result = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: TARGET_DATE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The only source-day assignment is on cocina; scoping to caja finds nothing to copy.
    expect(result.summary).toEqual({ copied: 0, noShift: 0, occupied: 0, alreadyThere: 0, forbidden: 0 });
  });

  it("picks the non-superseded target shift, never the superseded one it replaced (reimport)", async () => {
    const employeeId = await makeEmployee("copy-day-reimport");
    const sourceShift = await makeShift(employeeId, SOURCE_DATE, "10:00 am", "2:00 pm");
    await createAssignment({ shiftId: sourceShift.id, stationId: "green1", date: SOURCE_DATE, hour: 11 });

    // A reimport superseded the target day's old shift and created a new
    // one whose window also covers hour 11 — the copy must never attach to
    // the superseded row, regardless of which one the query returns first.
    const oldTargetShift = await makeShift(employeeId, TARGET_DATE, "9:00 am", "5:00 pm");
    await prisma.shift.update({
      where: { id: oldTargetShift.id },
      data: { supersededAt: chicagoDateTime(TARGET_DATE, "8:00 am") },
    });
    const newTargetShift = await makeShift(employeeId, TARGET_DATE, "10:00 am", "2:00 pm");

    const result = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: TARGET_DATE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.copied).toBe(1);
    const targetRow = await prisma.assignment.findFirst({
      where: { stationId: "green1", hourStart: chicagoDateTime(TARGET_DATE, "11:00 am") },
    });
    expect(targetRow?.shiftId).toBe(newTargetShift.id);
  });

  it("never picks a target shift on the other board", async () => {
    const employeeId = await makeEmployee("copy-day-other-board");
    const sourceShift = await makeShift(employeeId, SOURCE_DATE, "10:00 am", "2:00 pm", "caja");
    await createAssignment({ shiftId: sourceShift.id, stationId: "green1", date: SOURCE_DATE, hour: 11 });
    // Only a cocina shift exists on the target day — copying for caja must
    // find no eligible shift, not misattach to the wrong board's row.
    await makeShift(employeeId, TARGET_DATE, "10:00 am", "2:00 pm", "cocina");

    const result = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: TARGET_DATE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.noShift).toBe(1);
    expect(result.summary.copied).toBe(0);
  });

  it("a person already seated somewhere else on the target day counts as alreadyThere, not occupied", async () => {
    const employeeId = await makeEmployee("copy-day-busy-elsewhere");
    const sourceShift = await makeShift(employeeId, SOURCE_DATE, "10:00 am", "2:00 pm");
    await createAssignment({ shiftId: sourceShift.id, stationId: "green1", date: SOURCE_DATE, hour: 11 });
    const targetShift = await makeShift(employeeId, TARGET_DATE, "10:00 am", "2:00 pm");
    // Already seated at a different station on the target day, same hour.
    await createAssignment({ shiftId: targetShift.id, stationId: "purple1", date: TARGET_DATE, hour: 11 });

    const result = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: TARGET_DATE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.alreadyThere).toBe(1);
    expect(result.summary.occupied).toBe(0);
    expect(result.summary.copied).toBe(0);
    const greenRows = await prisma.assignment.count({
      where: { stationId: "green1", hourStart: chicagoDateTime(TARGET_DATE, "11:00 am") },
    });
    expect(greenRows).toBe(0);
  });

  it("refuses to copy a day onto itself", async () => {
    const result = await copyDayAssignments({ board: "caja", sourceDate: SOURCE_DATE, targetDate: SOURCE_DATE });
    expect(result.ok).toBe(false);
  });
});
