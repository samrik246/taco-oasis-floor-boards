import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { ALL_STATIONS, OBSOLETE_COCINA_STATION_IDS } from "@/lib/stations";
import { createAssignment } from "@/lib/assignments/service";
import { chicagoDateTime } from "@/lib/time";
import {
  assignTarea,
  buildTareaSuggestions,
  ensureTareaTemplates,
  listTareaAssignments,
  setTareaStatus,
} from "@/lib/tareas/service";
import {
  getTrafficState,
  setTrafficEnabled,
  tickTrafficIfDue,
} from "@/lib/traffic/service";
import { processReturnToStation } from "@/lib/tareas/return-service";
import { logPositionMove } from "@/lib/position-moves-service";
import { allLoadStationDefs } from "@/lib/load-stations";
import { allTareaTemplates } from "@/lib/board-config";
import { DEFAULT_PERFORMANCE_QUESTIONS } from "@/lib/performance/questions";
import {
  ensurePerformanceQuestions,
  upsertPerformanceAnswers,
} from "@/lib/performance/service";
import { createEmployee, updateEmployee } from "@/lib/employees/service";
import { getEmployeeWeekHours } from "@/lib/ledger";
import { KITCHEN_TAREA_TEMPLATES } from "@/lib/tareas/catalog";

const prisma = new PrismaClient();
const FIXTURE_XLSX = path.resolve(
  process.cwd(),
  "fixtures/wheniwork-restaurant-export-sample.xlsx",
);

describe("Phase 1 integration: traffic + tareas + return + moves", () => {
  beforeAll(async () => {
    await prisma.performanceAnswer.deleteMany();
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
    await prisma.performanceQuestion.deleteMany();

    for (const id of OBSOLETE_COCINA_STATION_IDS) {
      await prisma.employeeStationAbility.deleteMany({
        where: { stationId: id },
      });
      await prisma.station.deleteMany({ where: { id } });
    }

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
          board: s.board,
        },
      });
    }

    for (const t of allTareaTemplates()) {
      await prisma.tareaTemplate.upsert({
        where: { id: t.id },
        create: {
          id: t.id,
          code: t.code,
          label: t.label,
          mode: t.mode,
          sortOrder: t.sortOrder,
          board: t.board,
          lemonWarnOnGreens: t.lemonWarnOnGreens === true,
        },
        update: {
          board: t.board,
          label: t.label,
        },
      });
    }

    await prisma.trafficSimulatorConfig.create({
      data: { id: "default", enabled: false },
    });
    for (const s of allLoadStationDefs()) {
      await prisma.loadStationMeter.create({
        data: { loadStationId: s.id, level: "quiet", orderCount: 0 },
      });
    }

    for (const q of DEFAULT_PERFORMANCE_QUESTIONS) {
      await prisma.performanceQuestion.upsert({
        where: { id: q.id },
        create: {
          id: q.id,
          prompt: q.prompt,
          kind: q.kind,
          sortOrder: q.sortOrder,
          active: true,
        },
        update: {},
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
    let state = await setTrafficEnabled(true, "caja");
    expect(state.enabled).toBe(true);
    state = await tickTrafficIfDue({
      force: true,
      date: "2026-09-20",
      hour: 12,
      board: "caja",
    });
    expect(state.meters).toHaveLength(4);
    expect(state.lastTickAt).toBeTruthy();
    state = await setTrafficEnabled(false, "caja");
    expect(state.enabled).toBe(false);
    const idle = await getTrafficState("caja");
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

    const list = await listTareaAssignments("2026-09-20", "caja");
    expect(list.filter((t) => t.status === "working").length).toBeGreaterThanOrEqual(2);

    const suggestions = await buildTareaSuggestions({
      date: "2026-09-20",
      hour: 12,
      templateId: "crema_dulce",
      board: "caja",
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

  it("does not clear tareas or call people back when training is off", async () => {
    await setTrafficEnabled(false);
    const result = await processReturnToStation({
      date: "2026-09-20",
      hour: 14,
    });
    expect(result).toEqual({ created: 0, unassigned: 0 });
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

    await setTrafficEnabled(true);
    await prisma.loadStationMeter.update({
      where: { loadStationId: "cliente" },
      data: { level: "slammed", orderCount: 10 },
    });

    const result = await processReturnToStation({
      date: "2026-09-20",
      hour: 14,
    });
    await setTrafficEnabled(false);
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

  it("kitchen: traffic meters, tareas, return, hours, performance, employees", async () => {
    await ensureTareaTemplates();
    await ensurePerformanceQuestions();

    const kitchenState = await getTrafficState("cocina");
    expect(kitchenState.meters).toHaveLength(6);
    expect(kitchenState.meters.map((m) => m.loadStationId).sort()).toEqual([
      "birria",
      "carne",
      "fryer",
      "prepa",
      "taquero",
      "tortilla",
    ]);

    // Create a cocina employee + shift for the day
    const created = await createEmployee({
      firstName: "Kitchen",
      lastName: "Cook",
      externalId: "kitchen-cook-1",
      abilities: ALL_STATIONS.filter((s) => s.board === "cocina").map((s) => ({
        stationId: s.id,
        level: "ok" as const,
      })),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await updateEmployee(created.employee.id, {
      abilities: [
        ...ALL_STATIONS.filter((s) => s.board === "cocina").map((s) => ({
          stationId: s.id,
          level: (s.id === "fryer" ? "preferred" : "ok") as
            | "preferred"
            | "ok",
        })),
      ],
    });

    const shift = await prisma.shift.create({
      data: {
        employeeId: created.employee.id,
        date: "2026-09-20",
        startAt: chicagoDateTime("2026-09-20", "10:00 am"),
        endAt: chicagoDateTime("2026-09-20", "6:00 pm"),
        sourcePosition: "Cocina - Fryer",
        board: "cocina",
      },
    });

    const seat = await createAssignment({
      shiftId: shift.id,
      stationId: "fryer",
      date: "2026-09-20",
      hour: 12,
    });
    expect(seat.ok).toBe(true);

    const t1 = await assignTarea({
      date: "2026-09-20",
      employeeId: created.employee.id,
      templateId: "prep_salsa_bar",
      hour: 12,
    });
    expect(t1.ok).toBe(true);

    const t2 = await assignTarea({
      date: "2026-09-20",
      employeeId: created.employee.id,
      templateId: "restock_gloves",
      hour: 12,
    });
    expect(t2.ok).toBe(true);

    const kitchenTareas = await listTareaAssignments("2026-09-20", "cocina");
    expect(
      kitchenTareas.filter((t) => t.status === "working").length,
    ).toBeGreaterThanOrEqual(2);

    const suggestions = await buildTareaSuggestions({
      date: "2026-09-20",
      hour: 12,
      templateId: "restock_tortillas",
      board: "cocina",
    });
    expect(suggestions[0]?.label).toBe("top");

    expect(KITCHEN_TAREA_TEMPLATES.length).toBe(9);

    await setTrafficEnabled(true);
    await prisma.loadStationMeter.update({
      where: { loadStationId: "fryer" },
      data: { level: "slammed", orderCount: 12 },
    });

    const ret = await processReturnToStation({
      date: "2026-09-20",
      hour: 12,
      board: "cocina",
    });
    await setTrafficEnabled(false);
    expect(ret.unassigned).toBeGreaterThanOrEqual(1);

    // Complete a tarea for ledger minutes (use a fresh assign after return cleared)
    const t3 = await assignTarea({
      date: "2026-09-20",
      employeeId: created.employee.id,
      templateId: "wipe_line",
      hour: 12,
    });
    expect(t3.ok).toBe(true);
    if (t3.ok) {
      // Backdate assignedAt so minutes > 0
      await prisma.tareaAssignment.update({
        where: { id: t3.assignment.id },
        data: { assignedAt: new Date(Date.now() - 30 * 60_000) },
      });
      await setTareaStatus({ id: t3.assignment.id, status: "done" });
    }

    const ledger = await getEmployeeWeekHours(created.employee.id, "2026-09-20");
    expect(ledger).toBeTruthy();
    expect(ledger!.byStation.some((r) => r.stationId === "fryer")).toBe(true);
    expect(ledger!.byTarea.length).toBeGreaterThanOrEqual(1);
    expect(ledger!.totalTareaMinutes).toBeGreaterThan(0);

    const perf = await upsertPerformanceAnswers({
      date: "2026-09-20",
      board: "cocina",
      employeeId: created.employee.id,
      answers: [
        { questionId: "pq_stayed_on_station", value: "yes" },
        { questionId: "pq_tareas_finished", value: "finished" },
        { questionId: "pq_seat_tomorrow", value: "yes" },
        { questionId: "pq_free_note", value: "Solid fryer shift" },
      ],
    });
    expect(perf.ok).toBe(true);
  });
});
