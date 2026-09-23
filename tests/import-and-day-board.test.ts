import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { ALL_STATIONS } from "@/lib/stations";

const prisma = new PrismaClient();
const FIXTURE_XLSX = path.resolve(
  process.cwd(),
  "fixtures/wheniwork-restaurant-export-sample.xlsx",
);

describe("import persist + day board data", () => {
  beforeAll(async () => {
    // Clean slate for this suite
    await prisma.assignment.deleteMany();
    await prisma.shift.deleteMany();
    await prisma.importBatch.deleteMany();
    await prisma.employeeStationAbility.deleteMany();
    await prisma.employee.deleteMany();
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
        update: {
          board: s.board,
          label: s.label,
          color: s.color,
          maxConcurrent: s.maxConcurrent,
          sortOrder: s.sortOrder,
          priority: s.priority,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists employees/shifts without pay fields and supports multi-position 0042", async () => {
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const parsed = await parseScheduleWorkbook(buf, {
      filename: "wheniwork-restaurant-export-sample.xlsx",
    });
    const { rowCount, importBatchId } = await persistImport(
      parsed,
      "wheniwork-restaurant-export-sample.xlsx",
    );
    expect(rowCount).toBe(parsed.shifts.length);
    expect(importBatchId).toBeTruthy();

    const emp = await prisma.employee.findUnique({ where: { externalId: "0042" } });
    expect(emp).toBeTruthy();
    const shifts0042 = await prisma.shift.findMany({
      where: { employeeId: emp!.id },
    });
    expect(shifts0042.length).toBeGreaterThan(1);
    const positions = new Set(shifts0042.map((s) => s.sourcePosition));
    expect(positions.has("Caja - Regular")).toBe(true);
    expect(positions.has("Caja - Nieves")).toBe(true);

    // Ensure no pay-like columns exist on Shift model payloads
    const sample = shifts0042[0]!;
    expect(sample).not.toHaveProperty("hourlyRate");
    expect(sample).not.toHaveProperty("laborCost");
  });

  it("reads caja day board for 2026-09-20 with stations + shifts", async () => {
    const stations = await prisma.station.findMany({
      where: { board: "caja" },
      orderBy: { sortOrder: "asc" },
    });
    expect(stations.length).toBe(CAJA_COUNT);

    const shifts = await prisma.shift.findMany({
      where: { board: "caja", date: "2026-09-20" },
      include: { employee: true, assignments: true },
    });
    expect(shifts.length).toBeGreaterThan(0);
    for (const sh of shifts) {
      expect(sh.board).toBe("caja");
      expect(sh.date).toBe("2026-09-20");
      expect(sh.employee.externalId).toBeTruthy();
    }
  });

  it("rejects duplicate or overlapping imports without changing shifts or manual abilities", async () => {
    const beforeShifts = await prisma.shift.count();
    const employee = await prisma.employee.findUnique({ where: { externalId: "0042" } });
    expect(employee).toBeTruthy();
    await prisma.employeeStationAbility.upsert({
      where: { employeeId_stationId: { employeeId: employee!.id, stationId: "yellow" } },
      create: { employeeId: employee!.id, stationId: "yellow", level: "preferred" },
      update: { level: "preferred" },
    });
    const parsed = await parseScheduleWorkbook(fs.readFileSync(FIXTURE_XLSX), {
      filename: "renamed-copy.xlsx",
    });

    await expect(persistImport(parsed, "renamed-copy.xlsx")).rejects.toThrow(
      "already imported",
    );
    expect(await prisma.shift.count()).toBe(beforeShifts);
    expect(
      await prisma.employeeStationAbility.findUnique({
        where: { employeeId_stationId: { employeeId: employee!.id, stationId: "yellow" } },
      }),
    ).toMatchObject({ level: "preferred" });
  });
});

const CAJA_COUNT = 11;
