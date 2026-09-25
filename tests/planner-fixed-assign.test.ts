import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";
import { createEmployee } from "@/lib/employees/service";
import { createAssignment } from "@/lib/assignments/service";
import { placeFixedAssignments } from "@/lib/assignments/fixed-assign";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const DATE = "2026-09-20";

async function makeEmployee(externalId: string) {
  const created = await createEmployee({ firstName: "Test", lastName: externalId, externalId });
  if (!created.ok) throw new Error("setup: createEmployee failed");
  return created.employee.id;
}

async function makeShift(
  employeeId: string,
  sourcePosition: string,
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
      sourcePosition,
      board,
    },
  });
}

// Planner G: Colocar fijos places every mapped, non-superseded shift on the
// open board/date through createShiftAssignment only — same skip rules as A.
describe("placeFixedAssignments — Planner G", () => {
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
    await prisma.employee.deleteMany({ where: { externalId: { startsWith: "fixed-" } } });
    await prisma.positionStationMap.deleteMany();
    await prisma.employeeStationAbility.deleteMany();
  });

  it("places every mapped shift at its mapped station", async () => {
    await prisma.positionStationMap.create({ data: { position: "Caja Manager", stationId: "mana" } });
    await prisma.positionStationMap.create({ data: { position: "Caja - Nieves", stationId: "nieves" } });
    const managerId = await makeEmployee("fixed-manager");
    const nievesId = await makeEmployee("fixed-nieves");
    await makeShift(managerId, "Caja Manager", "10:00 am", "2:00 pm");
    await makeShift(nievesId, "Caja - Nieves", "11:00 am", "3:00 pm");

    const result = await placeFixedAssignments({ board: "caja", date: DATE });
    expect(result.summary.placed).toBe(8); // 4h + 4h
    expect(result.summary.forbidden).toBe(0);
    const managerRows = await prisma.assignment.count({ where: { stationId: "mana", employeeId: managerId } });
    const nievesRows = await prisma.assignment.count({ where: { stationId: "nieves", employeeId: nievesId } });
    expect(managerRows).toBe(4);
    expect(nievesRows).toBe(4);
  });

  it("leaves an unmapped position string untouched", async () => {
    const employeeId = await makeEmployee("fixed-unmapped");
    await makeShift(employeeId, "Caja - Regular", "10:00 am", "2:00 pm");
    const result = await placeFixedAssignments({ board: "caja", date: DATE });
    expect(result.summary.placed).toBe(0);
    const rows = await prisma.assignment.count({ where: { employeeId } });
    expect(rows).toBe(0);
  });

  it("mutant guard: an overwrite of a placed hour goes red — the existing row survives", async () => {
    await prisma.positionStationMap.create({ data: { position: "Caja Manager", stationId: "mana" } });
    const managerId = await makeEmployee("fixed-overwrite-a");
    const otherId = await makeEmployee("fixed-overwrite-b");
    const otherShift = await makeShift(otherId, "Caja - Regular", "10:00 am", "2:00 pm");
    await makeShift(managerId, "Caja Manager", "10:00 am", "2:00 pm");

    // Someone else already seated at mana, 11:00, before fijos runs.
    const preseated = await createAssignment({
      shiftId: otherShift.id,
      stationId: "mana",
      date: DATE,
      hour: 11,
    });
    expect(preseated.ok).toBe(true);
    if (!preseated.ok) return;
    const preseatedId = preseated.assignment.id;

    const result = await placeFixedAssignments({ board: "caja", date: DATE });
    expect(result.summary.placed).toBe(3); // 10, 12, 13 — not 11
    expect(result.summary.stationOccupied).toBe(1);

    const stillThere = await prisma.assignment.findUnique({ where: { id: preseatedId } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.employeeId).toBe(otherId);
    const rowsAt11 = await prisma.assignment.count({
      where: { stationId: "mana", hourStart: chicagoDateTime(DATE, "11:00 am") },
    });
    expect(rowsAt11).toBe(1);
  });

  it("mutant guard: a forbidden person placed by fijos goes red — nothing is written", async () => {
    await prisma.positionStationMap.create({ data: { position: "Caja Manager", stationId: "mana" } });
    const managerId = await makeEmployee("fixed-forbidden");
    await makeShift(managerId, "Caja Manager", "10:00 am", "2:00 pm");
    await prisma.employeeStationAbility.create({
      data: { employeeId: managerId, stationId: "mana", level: "forbidden" },
    });

    const result = await placeFixedAssignments({ board: "caja", date: DATE });
    expect(result.summary.placed).toBe(0);
    expect(result.summary.forbidden).toBe(1);
    const rows = await prisma.assignment.count({ where: { employeeId: managerId } });
    expect(rows).toBe(0);
  });

  it("a fully superseded shift is excluded from fijos entirely (per-hour superseded counting is createShiftAssignment's own, tested there)", async () => {
    await prisma.positionStationMap.create({ data: { position: "Caja Manager", stationId: "mana" } });
    const managerId = await makeEmployee("fixed-superseded");
    const shift = await makeShift(managerId, "Caja Manager", "10:00 am", "2:00 pm");
    await prisma.shift.update({
      where: { id: shift.id },
      data: { supersededAt: chicagoDateTime(DATE, "9:00 am") },
    });
    const result = await placeFixedAssignments({ board: "caja", date: DATE });
    expect(result.summary.placed).toBe(0);
    expect(result.summary.superseded).toBe(0);
  });
});
