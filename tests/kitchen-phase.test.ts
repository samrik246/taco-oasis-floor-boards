import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { ALL_STATIONS, LEGACY_COCINA_STATION_IDS } from "@/lib/stations";
import { createAssignment } from "@/lib/assignments/service";
import { chicagoDateTime } from "@/lib/time";
import {
  assignTarea,
  buildTareaSuggestions,
  ensureTareaTemplates,
  listTareaAssignments,
  listTareaTemplates,
} from "@/lib/tareas/service";
import {
  getTrafficState,
  setTrafficEnabled,
  tickTrafficIfDue,
} from "@/lib/traffic/service";
import { processReturnToStation } from "@/lib/tareas/return-service";
import { allLoadStationDefs, KITCHEN_LOAD_STATIONS } from "@/lib/load-stations";
import { ALL_TAREA_TEMPLATES } from "@/lib/tareas/catalog";
import { getEmployeeWeekHours } from "@/lib/ledger";
import { upsertPerformanceAnswer } from "@/lib/performance/service";
import { boardConfig } from "@/lib/board-config";

const prisma = new PrismaClient();
const FIXTURE_XLSX = path.resolve(
  process.cwd(),
  "fixtures/wheniwork-restaurant-export-sample.xlsx",
);

describe("Kitchen phase integration", () => {
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

    for (const id of LEGACY_COCINA_STATION_IDS) {
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
          sortOrder: s.sortOrder,
        },
      });
    }

    for (const t of ALL_TAREA_TEMPLATES) {
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
          preferSeatId: t.preferSeatId ?? null,
          warnOnSlammedLoadStationId: t.warnOnSlammedLoadStationId ?? null,
        },
        update: { board: t.board },
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

    const buf = fs.readFileSync(FIXTURE_XLSX);
    const parsed = await parseScheduleWorkbook(buf, {
      filename: "wheniwork-restaurant-export-sample.xlsx",
    });
    await persistImport(parsed, "wheniwork-restaurant-export-sample.xlsx");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("board config exposes six kitchen stations and load map", () => {
    const cfg = boardConfig("cocina");
    expect(cfg.stations.map((s) => s.id)).toEqual([
      "fryer",
      "tortilla",
      "birria",
      "taquero",
      "carne",
      "prepa",
    ]);
    expect(cfg.loadStations).toHaveLength(6);
    expect(cfg.multiSeatId).toBeNull();
  });

  it("lists kitchen tarea templates from seed", async () => {
    const templates = await listTareaTemplates("cocina");
    expect(templates.map((t) => t.id)).toContain("prep_salsa_bar");
    expect(templates.every((t) => t.board === "cocina")).toBe(true);
  });

  it("ticks kitchen traffic meters", async () => {
    await setTrafficEnabled(true, "cocina");
    const state = await tickTrafficIfDue({
      force: true,
      date: "2026-09-20",
      hour: 12,
      board: "cocina",
    });
    expect(state.meters).toHaveLength(KITCHEN_LOAD_STATIONS.length);
    expect(state.meters.map((m) => m.loadStationId)).toEqual([
      "fryer",
      "tortilla",
      "birria",
      "taquero",
      "carne",
      "prepa",
    ]);
    await setTrafficEnabled(false, "cocina");
    const idle = await getTrafficState("cocina");
    expect(idle.enabled).toBe(false);
  });

  it("assigns kitchen tareas with top/next suggestions", async () => {
    await ensureTareaTemplates();
    const shift = await prisma.shift.findFirst({
      where: {
        board: "cocina",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "12:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "12:00 pm") },
      },
    });
    expect(shift).toBeTruthy();

    const a1 = await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "prep_salsa_bar",
      hour: 12,
    });
    expect(a1.ok).toBe(true);

    const a2 = await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "wipe_line",
      hour: 12,
    });
    expect(a2.ok).toBe(true);

    const list = await listTareaAssignments("2026-09-20", "cocina");
    expect(list.filter((t) => t.status === "working").length).toBeGreaterThanOrEqual(
      2,
    );

    const suggestions = await buildTareaSuggestions({
      date: "2026-09-20",
      hour: 12,
      templateId: "restock_tortillas",
      board: "cocina",
    });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.label).toBe("top");
  });

  it("auto-unassigns kitchen tareas when fryer slammed", async () => {
    await prisma.returnPrompt.deleteMany();
    await prisma.tareaAssignment.deleteMany({ where: { date: "2026-09-20" } });
    await prisma.assignment.deleteMany();

    const shift = await prisma.shift.findFirst({
      where: {
        board: "cocina",
        date: "2026-09-20",
        startAt: { lte: chicagoDateTime("2026-09-20", "2:00 pm") },
        endAt: { gt: chicagoDateTime("2026-09-20", "2:00 pm") },
      },
    });
    expect(shift).toBeTruthy();

    const seat = await createAssignment({
      shiftId: shift!.id,
      stationId: "fryer",
      date: "2026-09-20",
      hour: 14,
    });
    expect(seat.ok).toBe(true);

    const tarea = await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "prep_salsa_bar",
      hour: 14,
    });
    expect(tarea.ok).toBe(true);

    await prisma.loadStationMeter.update({
      where: { loadStationId: "fryer" },
      data: { level: "slammed", orderCount: 10 },
    });

    const result = await processReturnToStation({
      date: "2026-09-20",
      hour: 14,
      board: "cocina",
    });
    expect(result.unassigned).toBeGreaterThanOrEqual(1);

    const prompts = await prisma.returnPrompt.findMany({
      where: { date: "2026-09-20", acknowledgedAt: null },
    });
    expect(prompts.length).toBeGreaterThanOrEqual(1);
  });

  it("ledger includes station and tarea minutes", async () => {
    const shift = await prisma.shift.findFirst({
      where: { board: "cocina", date: "2026-09-20" },
      include: { employee: true },
    });
    expect(shift).toBeTruthy();

    await prisma.assignment.deleteMany({
      where: { shift: { employeeId: shift!.employeeId } },
    });
    const seat = await createAssignment({
      shiftId: shift!.id,
      stationId: "taquero",
      date: "2026-09-20",
      hour: 11,
    });
    expect(seat.ok).toBe(true);

    await assignTarea({
      date: "2026-09-20",
      employeeId: shift!.employeeId,
      templateId: "stock_carne",
      hour: 11,
    });

    const ledger = await getEmployeeWeekHours(shift!.employeeId, "2026-09-20");
    expect(ledger).toBeTruthy();
    expect(ledger!.byStation.some((r) => r.stationId === "taquero")).toBe(true);
    expect(ledger!.totalTareaMinutes).toBeGreaterThanOrEqual(0);
    expect(ledger!.byTarea.length).toBeGreaterThanOrEqual(1);
  });

  it("stores close-day performance answers", async () => {
    const emp = await prisma.employee.findFirst({
      where: { shifts: { some: { board: "cocina", date: "2026-09-20" } } },
    });
    expect(emp).toBeTruthy();

    const result = await upsertPerformanceAnswer({
      date: "2026-09-20",
      board: "cocina",
      employeeId: emp!.id,
      answers: {
        stay_on_station: "yes",
        finished_tareas: "finished",
        seat_tomorrow: "maybe",
        free_note: "Solid on taquero",
      },
    });
    expect(result.ok).toBe(true);
  });
});
