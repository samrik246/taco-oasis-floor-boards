import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";
import { createEmployee } from "@/lib/employees/service";
import {
  listPositionMapRows,
  savePositionMapRow,
} from "@/lib/assignments/position-map-admin";
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
  board: string,
  supersededAt: Date | null = null,
) {
  const shift = await prisma.shift.create({
    data: {
      employeeId,
      date: DATE,
      startAt: chicagoDateTime(DATE, "10:00 am"),
      endAt: chicagoDateTime(DATE, "2:00 pm"),
      sourcePosition,
      board,
    },
  });
  if (supersededAt) {
    await prisma.shift.update({ where: { id: shift.id }, data: { supersededAt } });
  }
  return shift;
}

// Planner G Back office: the position -> station map editor's list and save.
describe("listPositionMapRows / savePositionMapRow — Back office", () => {
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
    await prisma.shift.deleteMany({ where: { date: DATE } });
    await prisma.employee.deleteMany({ where: { externalId: { startsWith: "posmap-" } } });
    await prisma.positionStationMap.deleteMany();
  });

  it("lists a one-board position as eligible with its board", async () => {
    const employeeId = await makeEmployee("posmap-single-board");
    await makeShift(employeeId, "Caja - Regular", "caja");
    const rows = await listPositionMapRows();
    const row = rows.find((r) => r.position === "Caja - Regular");
    expect(row).toEqual({ position: "Caja - Regular", board: "caja", eligible: true, stationId: null });
  });

  it("marks a position on the other board as not eligible", async () => {
    const employeeId = await makeEmployee("posmap-other-board");
    await makeShift(employeeId, "Catering setup", "other");
    const row = (await listPositionMapRows()).find((r) => r.position === "Catering setup");
    expect(row?.eligible).toBe(false);
    expect(row?.board).toBeNull();
  });

  it("marks a position that sits on two boards as not eligible", async () => {
    const employeeA = await makeEmployee("posmap-two-board-a");
    const employeeB = await makeEmployee("posmap-two-board-b");
    await makeShift(employeeA, "Cocina", "caja");
    await makeShift(employeeB, "Cocina", "cocina");
    const row = (await listPositionMapRows()).find((r) => r.position === "Cocina");
    expect(row?.eligible).toBe(false);
    expect(row?.board).toBeNull();
  });

  it("ignores a superseded shift when computing a position's board", async () => {
    const employeeId = await makeEmployee("posmap-superseded-ignored");
    // Only a superseded shift claims this position — it should not appear at all.
    await makeShift(employeeId, "Caja - Old Role", "caja", chicagoDateTime(DATE, "9:00 am"));
    const row = (await listPositionMapRows()).find((r) => r.position === "Caja - Old Role");
    expect(row).toBeUndefined();
  });

  it("still lists a saved key whose shifts have aged out", async () => {
    await prisma.positionStationMap.create({ data: { position: "Caja Manager", stationId: "mana" } });
    const row = (await listPositionMapRows()).find((r) => r.position === "Caja Manager");
    expect(row).toEqual({ position: "Caja Manager", board: null, eligible: false, stationId: "mana" });
  });

  it("saves a mapping for an eligible position on the matching board", async () => {
    const employeeId = await makeEmployee("posmap-save-ok");
    await makeShift(employeeId, "Caja - Nieves", "caja");
    const result = await savePositionMapRow("Caja - Nieves", "nieves");
    expect(result.ok).toBe(true);
    const row = (await listPositionMapRows()).find((r) => r.position === "Caja - Nieves");
    expect(row?.stationId).toBe("nieves");
  });

  it("clearing to none stores null, and a second load reports it unchanged", async () => {
    const employeeId = await makeEmployee("posmap-clear");
    await makeShift(employeeId, "Caja - Nieves", "caja");
    await savePositionMapRow("Caja - Nieves", "nieves");
    const cleared = await savePositionMapRow("Caja - Nieves", null);
    expect(cleared.ok).toBe(true);
    const row = (await listPositionMapRows()).find((r) => r.position === "Caja - Nieves");
    expect(row?.stationId).toBeNull();
  });

  it("refuses a station on the wrong board", async () => {
    const employeeId = await makeEmployee("posmap-wrong-board");
    await makeShift(employeeId, "Caja - Nieves", "caja");
    const result = await savePositionMapRow("Caja - Nieves", "fryer"); // cocina station
    expect(result.ok).toBe(false);
  });

  it("refuses to map a not-eligible (two-board) position", async () => {
    const employeeA = await makeEmployee("posmap-refuse-a");
    const employeeB = await makeEmployee("posmap-refuse-b");
    await makeShift(employeeA, "Cocina", "caja");
    await makeShift(employeeB, "Cocina", "cocina");
    const result = await savePositionMapRow("Cocina", "mana");
    expect(result.ok).toBe(false);
  });

  it("404s a nonexistent station", async () => {
    const employeeId = await makeEmployee("posmap-404");
    await makeShift(employeeId, "Caja - Nieves", "caja");
    const result = await savePositionMapRow("Caja - Nieves", "does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});
