import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";
import { createEmployee } from "@/lib/employees/service";
import { createAssignment } from "@/lib/assignments/service";
import {
  freeFavoriteFor,
  freeFavoritesForHour,
  suggestAssign,
} from "@/lib/assignments/suggest";
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

// Planner I: the Sugerido chip's candidate is a free favorite; the tap
// rechecks server-side and writes nothing for anyone else.
describe("freeFavoriteFor / suggestAssign — Planner I", () => {
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
    await prisma.employee.deleteMany({ where: { externalId: { startsWith: "suggest-" } } });
    await prisma.employeeStationAbility.deleteMany();
  });

  it("suggests the free favorite and the tap places their whole shift", async () => {
    const employeeId = await makeEmployee("suggest-basic");
    const shift = await makeShift(employeeId, "10:00 am", "2:00 pm");
    await prisma.employeeStationAbility.create({
      data: { employeeId, stationId: "green1", level: "preferred" },
    });

    const candidate = await freeFavoriteFor({ board: "caja", date: DATE, hour: 11, stationId: "green1" });
    expect(candidate?.shiftId).toBe(shift.id);

    const result = await suggestAssign({ board: "caja", date: DATE, hour: 11, stationId: "green1", shiftId: shift.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.placed).toBe(4); // whole shift, not one hour
    const rows = await prisma.assignment.count({ where: { stationId: "green1", employeeId } });
    expect(rows).toBe(4);
  });

  it("several favorites: earliest startAt wins", async () => {
    const laterId = await makeEmployee("suggest-later");
    const earlierId = await makeEmployee("suggest-earlier");
    await makeShift(laterId, "11:00 am", "3:00 pm");
    const earlierShift = await makeShift(earlierId, "9:00 am", "1:00 pm");
    for (const id of [laterId, earlierId]) {
      await prisma.employeeStationAbility.create({ data: { employeeId: id, stationId: "green1", level: "preferred" } });
    }
    const candidate = await freeFavoriteFor({ board: "caja", date: DATE, hour: 12, stationId: "green1" });
    expect(candidate?.shiftId).toBe(earlierShift.id);
    expect(candidate?.employeeId).toBe(earlierId);
  });

  it("excludes someone already seated elsewhere that hour", async () => {
    const employeeId = await makeEmployee("suggest-busy");
    const shift = await makeShift(employeeId, "10:00 am", "2:00 pm");
    await prisma.employeeStationAbility.create({ data: { employeeId, stationId: "green1", level: "preferred" } });
    await createAssignment({ shiftId: shift.id, stationId: "purple1", date: DATE, hour: 11 });

    const candidate = await freeFavoriteFor({ board: "caja", date: DATE, hour: 11, stationId: "green1" });
    expect(candidate).toBeNull();
  });

  it("excludes someone who is only ok, not preferred", async () => {
    const employeeId = await makeEmployee("suggest-not-preferred");
    await makeShift(employeeId, "10:00 am", "2:00 pm");
    await prisma.employeeStationAbility.create({ data: { employeeId, stationId: "green1", level: "ok" } });
    const candidate = await freeFavoriteFor({ board: "caja", date: DATE, hour: 11, stationId: "green1" });
    expect(candidate).toBeNull();
  });

  it("no candidate once the station's hour is already taken", async () => {
    const employeeId = await makeEmployee("suggest-taken");
    const otherId = await makeEmployee("suggest-taken-other");
    await makeShift(employeeId, "10:00 am", "2:00 pm");
    const otherShift = await makeShift(otherId, "10:00 am", "2:00 pm");
    await prisma.employeeStationAbility.create({ data: { employeeId, stationId: "green1", level: "preferred" } });
    await createAssignment({ shiftId: otherShift.id, stationId: "green1", date: DATE, hour: 11 });

    const candidate = await freeFavoriteFor({ board: "caja", date: DATE, hour: 11, stationId: "green1" });
    expect(candidate).toBeNull();
  });

  it("mutant guard: a sugerido who is not a free favorite writes nothing", async () => {
    const realFavoriteId = await makeEmployee("suggest-real");
    const impostorId = await makeEmployee("suggest-impostor");
    await makeShift(realFavoriteId, "10:00 am", "2:00 pm");
    const impostorShift = await makeShift(impostorId, "10:00 am", "2:00 pm");
    await prisma.employeeStationAbility.create({ data: { employeeId: realFavoriteId, stationId: "green1", level: "preferred" } });
    // impostor is NOT preferred at green1 — not a free favorite at all.

    const result = await suggestAssign({
      board: "caja",
      date: DATE,
      hour: 11,
      stationId: "green1",
      shiftId: impostorShift.id,
    });
    expect(result.ok).toBe(false);
    const rows = await prisma.assignment.count({ where: { employeeId: impostorId } });
    expect(rows).toBe(0);
  });

  it("mutant guard: a stale chip for a favorite who is no longer free writes nothing", async () => {
    const employeeId = await makeEmployee("suggest-stale");
    const otherId = await makeEmployee("suggest-stale-other");
    const shift = await makeShift(employeeId, "10:00 am", "2:00 pm");
    const otherShift = await makeShift(otherId, "10:00 am", "2:00 pm");
    await prisma.employeeStationAbility.create({ data: { employeeId, stationId: "green1", level: "preferred" } });

    // Someone else took the seat between the chip rendering and the tap.
    await createAssignment({ shiftId: otherShift.id, stationId: "green1", date: DATE, hour: 11 });

    const result = await suggestAssign({ board: "caja", date: DATE, hour: 11, stationId: "green1", shiftId: shift.id });
    expect(result.ok).toBe(false);
    const rows = await prisma.assignment.count({ where: { employeeId, stationId: "green1" } });
    expect(rows).toBe(0);
  });

  it("freeFavoritesForHour matches freeFavoriteFor for every station, in one call", async () => {
    const freeId = await makeEmployee("suggest-batch-free");
    const takenId = await makeEmployee("suggest-batch-taken");
    await makeShift(freeId, "10:00 am", "2:00 pm");
    const takenShift = await makeShift(takenId, "10:00 am", "2:00 pm");
    await prisma.employeeStationAbility.create({ data: { employeeId: freeId, stationId: "green1", level: "preferred" } });
    await prisma.employeeStationAbility.create({ data: { employeeId: takenId, stationId: "purple1", level: "preferred" } });
    await createAssignment({ shiftId: takenShift.id, stationId: "purple1", date: DATE, hour: 11 });

    const batch = await freeFavoritesForHour({ board: "caja", date: DATE, hour: 11 });
    expect(batch.green1?.employeeId).toBe(freeId);
    expect(batch.purple1).toBeNull(); // station occupied
    expect(batch.yellow ?? null).toBeNull(); // no favorite there

    const single = await freeFavoriteFor({ board: "caja", date: DATE, hour: 11, stationId: "green1" });
    expect(single?.employeeId).toBe(batch.green1?.employeeId);
  });
});
