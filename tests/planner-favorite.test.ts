import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";
import { createEmployee } from "@/lib/employees/service";
import { toggleFavorite } from "@/lib/abilities/favorite";

const prisma = new PrismaClient();

// Planner H: the favorite star toggles preferred<->ok only, direct on the
// one EmployeeStationAbility row (never through updateEmployee).
describe("toggleFavorite", () => {
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
    await prisma.employeeStationAbility.deleteMany();
    await prisma.employee.deleteMany({ where: { externalId: { startsWith: "favorite-" } } });
  });

  async function makeEmployee(externalId: string) {
    const created = await createEmployee({ firstName: "Test", lastName: externalId, externalId });
    if (!created.ok) throw new Error("setup: createEmployee failed");
    return created.employee.id;
  }

  it("a missing row becomes preferred", async () => {
    const employeeId = await makeEmployee("favorite-missing");
    const result = await toggleFavorite(employeeId, "green1");
    expect(result).toEqual({ ok: true, level: "preferred" });
    const row = await prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId, stationId: "green1" } },
    });
    expect(row?.level).toBe("preferred");
  });

  it("toggles ok -> preferred -> ok", async () => {
    const employeeId = await makeEmployee("favorite-toggle");
    await prisma.employeeStationAbility.create({
      data: { employeeId, stationId: "green1", level: "ok" },
    });
    const toPreferred = await toggleFavorite(employeeId, "green1");
    expect(toPreferred).toEqual({ ok: true, level: "preferred" });
    const toOk = await toggleFavorite(employeeId, "green1");
    expect(toOk).toEqual({ ok: true, level: "ok" });
  });

  it("does not change a forbidden row", async () => {
    const employeeId = await makeEmployee("favorite-forbidden");
    await prisma.employeeStationAbility.create({
      data: { employeeId, stationId: "green1", level: "forbidden" },
    });
    const result = await toggleFavorite(employeeId, "green1");
    expect(result).toEqual({ ok: true, level: "forbidden" });
    const row = await prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId, stationId: "green1" } },
    });
    expect(row?.level).toBe("forbidden");
  });

  it("does not change a training row", async () => {
    const employeeId = await makeEmployee("favorite-training");
    await prisma.employeeStationAbility.create({
      data: { employeeId, stationId: "green1", level: "training" },
    });
    const result = await toggleFavorite(employeeId, "green1");
    expect(result).toEqual({ ok: true, level: "training" });
    const row = await prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId, stationId: "green1" } },
    });
    expect(row?.level).toBe("training");
  });

  it("404s a nonexistent employee or station", async () => {
    const employeeId = await makeEmployee("favorite-404");
    const noEmployee = await toggleFavorite("does-not-exist", "green1");
    expect(noEmployee.ok).toBe(false);
    const noStation = await toggleFavorite(employeeId, "does-not-exist");
    expect(noStation.ok).toBe(false);
  });
});
