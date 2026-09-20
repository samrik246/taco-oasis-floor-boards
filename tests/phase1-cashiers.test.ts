import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { ALL_STATIONS } from "@/lib/stations";
import { createAssignment } from "@/lib/assignments/service";
import { chicagoDateTime } from "@/lib/time";
import {
  assignTarea,
  buildTareaSuggestions,
  ensureTareaTemplates,
  listTareaAssignments,
} from "@/lib/tareas/service";
import {
  getTrafficState,
  setTrafficEnabled,
  tickTrafficIfDue,
} from "@/lib/traffic/service";
import { processReturnToStation } from "@/lib/tareas/return-service";
import { logPositionMove } from "@/lib/position-moves-service";
import { CASHIER_LOAD_STATIONS } from "@/lib/load-stations";
import { CASHIER_TAREA_TEMPLATES } from "@/lib/tareas/catalog";

const prisma = new PrismaClient();
const FIXTURE_XLSX = path.resolve(
  process.cwd(),
  "fixtures/wheniwork-restaurant-export-sample.xlsx",
);

describe("Phase 1 integration: traffic + tareas + return + moves", () => {
  beforeAll(async () => {
    await prisma.returnPrompt.deleteMany();
    await prisma.tareaAssignment.deleteMany();
    await prisma.positionMoveLog.deleteMany();
    await prisma.assignment.deleteMany();
    await prisma.shift.deleteMany();
    await prisma.importBatch.deleteMany();
    await prisma.employeeStationAbility.deleteMany();
    await prisma.employee.deleteMany();
    await prisma.loadStationMeter.deleteMany();
    await prisma.trafficSimulatorConfig.deleteMany();
    await prisma.tareaTemplate.deleteMany();

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
          maxConcurrent: s.maxConcurrent,
          label: s.label,
          color: s.color,
        },
      });
    }

    for (const t of CASHIER_TAREA_TEMPLATES) {
      await prisma.tareaTemplate.upsert({
        where: { id: t.id },
        create: {
          id: t.id,
          code: t.code,
          label: t.label,
          mode: t.mode,
          sortOrder: t.sortOrder,
          lemonWarnOnGreens: t.lemonWarnOnGreens === true,
        },
        update: {},
      });
    }

    await prisma.trafficSimulatorConfig.create({
      data: { id: "default", enabled: false },
    });
    for (const s of CASHIER_LOAD_STATIONS) {
      await prisma.loadStationMeter.create({
        data: { loadStationId: s.id, level: "quiet", orderCount: 0 },
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

  it("toggles simulator and ticks meters", async () => {
    let state = await setTrafficEnabled(true);
    expect(state.enabled).toBe(true);
    state = await tickTrafficIfDue({
      force: true,
      date: "2026-09-20",
      hour: 12,
    });
    expect(state.meters).toHaveLength(4);
    expect(state.lastTickAt).toBeTruthy();
    state = await setTrafficEnabled(false);
    expect(state.enabled).toBe(false);
    const idle = await getTrafficState();
    expect(idle.enabled).toBe(false);
  });

  it("assigns multiple tareas and returns top/next suggestions", async () => {
    await ensureTareaTemplates();
    const shift = await prisma.shift.findFirst({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "12:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "12:00 pm") },
      },
    });
    expect(shift).toBeTruthy();

    const a1 = await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "salsa",
      hour: 12,
    });
    expect(a1.ok).toBe(true);

    const a2 = await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "ranch",
      hour: 12,
    });
    expect(a2.ok).toBe(true);

    const list = await listTareaAssignments("2026-09-20");
    expect(list.filter((t) => t.status === "working").length).toBeGreaterThanOrEqual(2);

    const suggestions = await buildTareaSuggestions({
      date: "2026-09-20",
      hour: 12,
      templateId: "crema_dulce",
    });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.label).toBe("top");
    if (suggestions[1]) expect(suggestions[1].label).toBe("next");
  });

  it("warns lemon on greens unless forced", async () => {
    await prisma.assignment.deleteMany();
    const shift = await prisma.shift.findFirst({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "1:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "1:00 pm") },
      },
    });
    expect(shift).toBeTruthy();

    const seat = await createAssignment({
      shiftId: shift!.id,
      stationId: "green1",
      date: "2026-09-20",
      hour: 13,
    });
    expect(seat.ok).toBe(true);

    const warn = await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "lemon",
      hour: 13,
      forceLemon: false,
    });
    expect(warn.ok).toBe(false);
    if (!warn.ok) expect(warn.code).toBe("LEMON_WARN_GREENS");

    const forced = await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "lemon",
      hour: 13,
      forceLemon: true,
    });
    expect(forced.ok).toBe(true);
  });

  it("auto-unassigns tareas and creates return prompt when slammed", async () => {
    await prisma.returnPrompt.deleteMany();
    await prisma.tareaAssignment.deleteMany({ where: { date: "2026-09-20" } });
    await prisma.assignment.deleteMany();

    const shift = await prisma.shift.findFirst({
      where: {
        board: "caja",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "2:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "2:00 pm") },
      },
    });
    expect(shift).toBeTruthy();

    const seat = await createAssignment({
      shiftId: shift!.id,
      stationId: "green2",
      date: "2026-09-20",
      hour: 14,
    });
    expect(seat.ok).toBe(true);

    const tarea = await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "salsa",
      hour: 14,
    });
    expect(tarea.ok).toBe(true);

    await prisma.loadStationMeter.update({
      where: { loadStationId: "cliente" },
      data: { level: "slammed", orderCount: 10 },
    });

    const result = await processReturnToStation({
      date: "2026-09-20",
      hour: 14,
    });
    expect(result.unassigned).toBeGreaterThanOrEqual(1);

    const prompts = await prisma.returnPrompt.findMany({
      where: { date: "2026-09-20", acknowledgedAt: null },
    });
    expect(prompts.length).toBeGreaterThanOrEqual(1);

    const cleared = await prisma.tareaAssignment.findMany({
      where: { employeeId: shift!.employeeId, date: "2026-09-20" },
    });
    expect(cleared.every((t) => t.unassignedAt != null)).toBe(true);
  });

  it("logs position move with reason", async () => {
    const emp = await prisma.employee.findFirst();
    expect(emp).toBeTruthy();
    const result = await logPositionMove({
      date: "2026-09-20",
      hour: 14,
      employeeId: emp!.id,
      fromStationId: "yellow",
      toStationId: null,
      reason: "Break",
      note: "quick water",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.log.reason).toBe("Break");
      expect(result.log.note).toBe("quick water");
    }
  });
});
