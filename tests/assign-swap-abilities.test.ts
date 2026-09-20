import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { ALL_STATIONS } from "@/lib/stations";
import {
  createAssignment,
  deleteAssignment,
  swapAssignments,
} from "@/lib/assignments/service";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const FIXTURE_XLSX = path.resolve(
  process.cwd(),
  "fixtures/wheniwork-restaurant-export-sample.xlsx",
);

describe("assign / swap / clear + abilities enforcement", () => {
  beforeAll(async () => {
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

    const buf = fs.readFileSync(FIXTURE_XLSX);
    const parsed = await parseScheduleWorkbook(buf, {
      filename: "wheniwork-restaurant-export-sample.xlsx",
    });
    await persistImport(parsed, "wheniwork-restaurant-export-sample.xlsx");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("seeds abilities on import from Position", async () => {
    const manager = await prisma.employee.findFirst({
      where: {
        shifts: { some: { sourcePosition: "Caja Manager", date: "2026-09-20" } },
      },
      include: { abilities: true },
    });
    expect(manager).toBeTruthy();
    const mana = manager!.abilities.find((a) => a.stationId === "mana");
    expect(mana?.level).toBe("preferred");
    const cocina = manager!.abilities.find((a) => a.stationId === "linea");
    expect(cocina?.level).toBe("forbidden");
  });

  it("assigns within shift and rejects out-of-shift", async () => {
    await prisma.assignment.deleteMany();

    const shift = await prisma.shift.findFirst({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "10:00 am") },
        endAt: { gt: chicagoDateTime("2026-09-20", "10:00 am") },
      },
    });
    expect(shift).toBeTruthy();

    const ok = await createAssignment({
      shiftId: shift!.id,
      stationId: "yellow",
      date: "2026-09-20",
      hour: 10,
    });
    expect(ok.ok).toBe(true);

    // Pick an in-grid hour at or after exclusive shift end
    const endHourUtc = shift!.endAt;
    const { toZonedTime } = await import("date-fns-tz");
    const endLocal = toZonedTime(endHourUtc, "America/Chicago");
    let outHour = endLocal.getHours();
    if (outHour < 7) outHour = 7;
    if (outHour > 21) outHour = 21;

    const bad = await createAssignment({
      shiftId: shift!.id,
      stationId: "blue",
      date: "2026-09-20",
      hour: outHour,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.violations.some((v) => v.code === "OUT_OF_SHIFT")).toBe(true);
    }

    const invalidHour = await createAssignment({
      shiftId: shift!.id,
      stationId: "blue",
      date: "2026-09-20",
      hour: 6,
    });
    expect(invalidHour.ok).toBe(false);
    if (!invalidHour.ok) {
      expect(invalidHour.violations.some((v) => v.code === "INVALID_HOUR")).toBe(
        true,
      );
    }
  });

  it("rejects double green1 and allows multi nieves", async () => {
    await prisma.assignment.deleteMany();

    const shifts = await prisma.shift.findMany({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "11:00 am") },
        endAt: { gt: chicagoDateTime("2026-09-20", "11:00 am") },
      },
      take: 3,
    });
    expect(shifts.length).toBeGreaterThanOrEqual(2);

    const a1 = await createAssignment({
      shiftId: shifts[0]!.id,
      stationId: "green1",
      date: "2026-09-20",
      hour: 11,
    });
    expect(a1.ok).toBe(true);

    const a2 = await createAssignment({
      shiftId: shifts[1]!.id,
      stationId: "green1",
      date: "2026-09-20",
      hour: 11,
    });
    expect(a2.ok).toBe(false);
    if (!a2.ok) {
      expect(a2.violations.some((v) => v.code === "STATION_FULL")).toBe(true);
    }

    // nieves stacking
    const n1 = await createAssignment({
      shiftId: shifts[0]!.id,
      stationId: "nieves",
      date: "2026-09-20",
      hour: 12,
    });
    // first person may already be assigned at 11 — use hour 12; clear person conflict by using different hours
    // shifts[0] was assigned at 11 on green1 — for hour 12 they should be free
    expect(n1.ok).toBe(true);

    const n2 = await createAssignment({
      shiftId: shifts[1]!.id,
      stationId: "nieves",
      date: "2026-09-20",
      hour: 12,
    });
    expect(n2.ok).toBe(true);
  });

  it("blocks forbidden ability assigns", async () => {
    await prisma.assignment.deleteMany();

    const shift = await prisma.shift.findFirst({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "2:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "2:00 pm") },
      },
      include: { employee: true },
    });
    expect(shift).toBeTruthy();

    // Force forbidden on purple1 for this employee
    await prisma.employeeStationAbility.upsert({
      where: {
        employeeId_stationId: {
          employeeId: shift!.employeeId,
          stationId: "purple1",
        },
      },
      create: {
        employeeId: shift!.employeeId,
        stationId: "purple1",
        level: "forbidden",
      },
      update: { level: "forbidden" },
    });

    const result = await createAssignment({
      shiftId: shift!.id,
      stationId: "purple1",
      date: "2026-09-20",
      hour: 14,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.code === "FORBIDDEN_ABILITY")).toBe(
        true,
      );
    }
  });

  it("clears an assignment", async () => {
    await prisma.assignment.deleteMany();
    const shift = await prisma.shift.findFirst({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "1:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "1:00 pm") },
      },
    });
    const created = await createAssignment({
      shiftId: shift!.id,
      stationId: "multi",
      date: "2026-09-20",
      hour: 13,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const cleared = await deleteAssignment(created.assignment.id);
    expect(cleared.ok).toBe(true);
    const gone = await prisma.assignment.findUnique({
      where: { id: created.assignment.id },
    });
    expect(gone).toBeNull();
  });

  it("swaps two assignments", async () => {
    await prisma.assignment.deleteMany();

    const shifts = await prisma.shift.findMany({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "3:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "3:00 pm") },
      },
      take: 2,
    });
    expect(shifts.length).toBe(2);

    // Ensure both can work yellow and blue
    for (const sh of shifts) {
      for (const stationId of ["yellow", "blue"]) {
        await prisma.employeeStationAbility.upsert({
          where: {
            employeeId_stationId: {
              employeeId: sh.employeeId,
              stationId,
            },
          },
          create: {
            employeeId: sh.employeeId,
            stationId,
            level: "ok",
          },
          update: { level: "ok" },
        });
      }
    }

    const a = await createAssignment({
      shiftId: shifts[0]!.id,
      stationId: "yellow",
      date: "2026-09-20",
      hour: 15,
    });
    const b = await createAssignment({
      shiftId: shifts[1]!.id,
      stationId: "blue",
      date: "2026-09-20",
      hour: 15,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const swapped = await swapAssignments(a.assignment.id, b.assignment.id);
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;

    const aAfter = await prisma.assignment.findUnique({
      where: { id: a.assignment.id },
    });
    const bAfter = await prisma.assignment.findUnique({
      where: { id: b.assignment.id },
    });
    expect(aAfter?.shiftId).toBe(shifts[1]!.id);
    expect(bAfter?.shiftId).toBe(shifts[0]!.id);
  });
});
