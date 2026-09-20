import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { ALL_STATIONS } from "@/lib/stations";
import { createAssignment } from "@/lib/assignments/service";
import { getEmployeeWeekHours } from "@/lib/ledger";
import {
  createNote,
  deleteNote,
  listNotes,
  updateNote,
  NOTE_AUTHOR,
} from "@/lib/notes";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const FIXTURE_XLSX = path.resolve(
  process.cwd(),
  "fixtures/wheniwork-restaurant-export-sample.xlsx",
);

describe("Stage 3 ledger + manager notes", () => {
  beforeAll(async () => {
    await prisma.managerNote.deleteMany();
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

  it("bumps employee week ledger after assignment", async () => {
    await prisma.assignment.deleteMany();

    const shift = await prisma.shift.findFirst({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "12:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "12:00 pm") },
      },
      include: { employee: true },
    });
    expect(shift).toBeTruthy();

    const before = await getEmployeeWeekHours(shift!.employeeId, "2026-09-20");
    expect(before).toBeTruthy();
    const beforeMins = before!.totalMinutes;

    const ok = await createAssignment({
      shiftId: shift!.id,
      stationId: "yellow",
      date: "2026-09-20",
      hour: 12,
    });
    expect(ok.ok).toBe(true);

    const after = await getEmployeeWeekHours(shift!.employeeId, "2026-09-20");
    expect(after!.totalMinutes).toBe(beforeMins + 60);
    const yellow = after!.byStation.find((r) => r.stationId === "yellow");
    expect(yellow?.minutes).toBeGreaterThanOrEqual(60);
    expect(after!.weekStart).toBe("2026-09-20");
  });

  it("creates, lists, updates, deletes manager day notes", async () => {
    await prisma.managerNote.deleteMany();

    const created = await createNote({
      board: "caja",
      date: "2026-09-20",
      body: "  Cover green1 lunch rush  ",
    });
    expect(created.author).toBe(NOTE_AUTHOR);
    expect(created.body).toBe("Cover green1 lunch rush");
    expect(created.chicagoTimestamp).toBeTruthy();
    expect(created.board).toBe("caja");
    expect(created.date).toBe("2026-09-20");

    const listed = await listNotes("caja", "2026-09-20");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);

    const updated = await updateNote(created.id, "Updated cover plan");
    expect(updated?.body).toBe("Updated cover plan");
    expect(updated?.author).toBe(NOTE_AUTHOR);

    const cocina = await listNotes("cocina", "2026-09-20");
    expect(cocina).toHaveLength(0);

    const removed = await deleteNote(created.id);
    expect(removed).toBe(true);
    expect(await listNotes("caja", "2026-09-20")).toHaveLength(0);
  });

  it("rejects empty note body", async () => {
    await expect(
      createNote({ board: "caja", date: "2026-09-20", body: "   " }),
    ).rejects.toThrow(/empty/i);
  });
});
