import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { ALL_STATIONS } from "@/lib/stations";
import { createAssignment, clearAssignment } from "@/lib/assignments/service";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const FIXTURE_XLSX = path.resolve(
  process.cwd(),
  "fixtures/wheniwork-restaurant-export-sample.xlsx",
);

// Planner E: a future hour clears in one tap (no reason, no log row); the
// current hour and any past hour keep the Phase 1 reason requirement, and
// the log row + delete happen in one transaction.
describe("clearAssignment — Planner E reason gate", () => {
  beforeAll(async () => {
    await prisma.assignment.deleteMany();
    await prisma.shift.deleteMany();
    await prisma.importBatch.deleteMany();
    await prisma.positionMoveLog.deleteMany();
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

  beforeEach(async () => {
    await prisma.assignment.deleteMany();
    await prisma.positionMoveLog.deleteMany();
  });

  function clockOf(hour24: number): string {
    const suffix = hour24 >= 12 ? "pm" : "am";
    const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${h12}:00 ${suffix}`;
  }

  async function seatAt(hour: number) {
    const shift = await prisma.shift.findFirst({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", clockOf(hour)) },
        endAt: { gt: chicagoDateTime("2026-09-20", clockOf(hour)) },
      },
    });
    expect(shift).toBeTruthy();
    const created = await createAssignment({
      shiftId: shift!.id,
      stationId: "multi",
      date: "2026-09-20",
      hour,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("setup: assign failed");
    return created.assignment.id;
  }

  it("a future hour clears with no reason and writes no log row", async () => {
    const id = await seatAt(14);
    const now = chicagoDateTime("2026-09-20", "1:00 pm"); // before the 14:00 hour
    const result = await clearAssignment({ id, now });
    expect(result.ok).toBe(true);
    const gone = await prisma.assignment.findUnique({ where: { id } });
    expect(gone).toBeNull();
    const logs = await prisma.positionMoveLog.findMany();
    expect(logs).toHaveLength(0);
  });

  it("the current hour with no reason is rejected — assignment and no log row survive", async () => {
    const id = await seatAt(14);
    const now = chicagoDateTime("2026-09-20", "2:00 pm"); // exactly hourStart — not future
    const result = await clearAssignment({ id, now });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    const stillThere = await prisma.assignment.findUnique({ where: { id } });
    expect(stillThere).not.toBeNull();
    const logs = await prisma.positionMoveLog.findMany();
    expect(logs).toHaveLength(0);
  });

  it("a past hour with no reason is rejected — same as the current hour", async () => {
    const id = await seatAt(13);
    const now = chicagoDateTime("2026-09-20", "4:00 pm"); // well after the 13:00 hour
    const result = await clearAssignment({ id, now });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    const stillThere = await prisma.assignment.findUnique({ where: { id } });
    expect(stillThere).not.toBeNull();
  });

  it("a past hour with an invalid reason string is rejected", async () => {
    const id = await seatAt(13);
    const now = chicagoDateTime("2026-09-20", "4:00 pm");
    const result = await clearAssignment({ id, reason: "Lunch", now });
    expect(result.ok).toBe(false);
  });

  it("the current hour with a valid reason clears and logs exactly one row, in one transaction", async () => {
    const id = await seatAt(14);
    const now = chicagoDateTime("2026-09-20", "2:00 pm");
    const result = await clearAssignment({
      id,
      reason: "Break",
      note: "  short break  ",
      now,
    });
    expect(result.ok).toBe(true);
    const gone = await prisma.assignment.findUnique({ where: { id } });
    expect(gone).toBeNull();
    const logs = await prisma.positionMoveLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.date).toBe("2026-09-20");
    expect(logs[0]!.hour).toBe(14);
    expect(logs[0]!.reason).toBe("Break");
    expect(logs[0]!.note).toBe("short break");
    expect(logs[0]!.fromStationId).toBe("multi");
    expect(logs[0]!.assignmentId).toBe(id);
  });

  it("clearing a nonexistent assignment 404s", async () => {
    const result = await clearAssignment({ id: "does-not-exist" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});
