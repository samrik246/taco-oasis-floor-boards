import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ALL_STATIONS } from "@/lib/stations";
import { chicagoHourStart } from "@/lib/hour-grid";
import { previewImport, commitImport } from "@/lib/import/persist-import";
import { NIEVES_POSITION } from "@/lib/import/nieves";
import { migrateQuarterStorage, CAPABILITY_SHA256, digest } from "@/lib/quarter/schema";
import { withReleaseLease } from "@/lib/quarter/lease";
import { assignedIntervals, resolvePaintWorld, sourceSnapshot } from "@/lib/quarter/world";
import { removeRestoreV2 } from "@/lib/quarter/removals";
import { paintV2 } from "@/lib/quarter/transaction";
import type { ParseResult } from "@/lib/parser/schedule-parser";

const date = "2042-10-12", ten = +chicagoHourStart(date, 10), now = new Date(ten - 3_600_000);
const minute = 60_000;
const root = fs.mkdtempSync(path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "nieves-import-"));
const template = path.join(root, "prepared.db"), originalUrl = process.env.DATABASE_URL;
let db: PrismaClient;
type Row = { id: string; start?: number; end?: number; role?: string };
function schedule(rows: Row[]): ParseResult {
  return { dates: [date], bucketCounts: { caja: rows.length, cocina: 0, other: 0 }, strippedPayColumns: [],
    shifts: rows.map(r => ({ externalId: r.id, firstName: r.id, lastName: "Synthetic", date,
      startAt: new Date(ten + (r.start ?? 0) * minute), endAt: new Date(ten + (r.end ?? 60) * minute),
      sourcePosition: r.role ?? NIEVES_POSITION, board: "caja", stationHint: null })) };
}
async function load(rows: Row[]) {
  const parsed = schedule(rows), preview = await previewImport(parsed, { client: db, now });
  return commitImport(parsed, "nieves-synthetic.csv", { client: db, now, expected: preview });
}
const world = () => db.$transaction(tx => resolvePaintWorld(tx, date));
async function work() { return assignedIntervals(await world()); }
async function source(externalId: string, start = 0) {
  return (await db.shift.findFirst({ where: { employee: { externalId }, startAt: new Date(ten + start * minute), supersededAt: null } }))!;
}
async function signature() {
  return (await work()).map(s => [s.shiftId, s.startMs, s.endMs, s.stationId, s.seatNumber]);
}
async function edit(phase: string, id: string, hour: number, stationId: string | null, sourceStart = 0, minutes = [0, 15, 30, 45]) {
  const shift = await source(id, sourceStart), start = +chicagoHourStart(date, hour);
  if (phase === "prepared") {
    const existing = (await db.assignment.findFirst({ where: { shiftId: shift.id, hourStart: new Date(start) } }))!;
    if (stationId) await db.assignment.update({ where: { id: existing.id }, data: { stationId, seatNumber: null } });
    else await db.assignment.delete({ where: { id: existing.id } });
    return;
  }
  const w = await world();
  await paintV2({ protocol: 2, requestId: randomUUID(), capabilitySha256: CAPABILITY_SHA256, board: "caja", date,
    expected: { databaseEpoch: w.state!.databaseEpoch, worldRevision: w.revision! },
    sources: w.sources.filter(s => !s.supersededAt && !s.boardRemoved).map(s => ({ shiftId: s.id, employeeId: s.employeeId, date, board: "caja" as const,
      sourcePosition: s.sourcePosition, startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), supersededAt: null, boardRemoved: false })),
    hours: w.hours.map(h => h.revision === null ? { shiftId: h.shiftId, hourStart: new Date(h.hourStartMs).toISOString(), revision: null, legacySha256: h.legacySha256 }
      : { shiftId: h.shiftId, hourStart: new Date(h.hourStartMs).toISOString(), revision: h.revision }),
    intents: minutes.map(m => ({ shiftId: shift.id, quarter: `${hour}:${String(m).padStart(2, "0")}`,
      ...(stationId ? { action: "station" as const, stationId } : { action: "erase" as const }) })) },
  { id: "synthetic-manager", name: "Synthetic" }, now, db);
}

beforeAll(async () => {
  fs.writeFileSync(template, "");
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], { env: { ...process.env, DATABASE_URL: `file:${template}` }, stdio: "pipe" });
  const init = new PrismaClient({ datasources: { db: { url: `file:${template}` } } });
  for (const s of ALL_STATIONS) await init.station.create({ data: { id: s.id, board: s.board, label: s.label, color: s.color, maxConcurrent: s.maxConcurrent, sortOrder: s.sortOrder, priority: s.priority } });
  await init.positionStationMap.create({ data: { position: NIEVES_POSITION, stationId: "nieves" } });
  process.env.DATABASE_URL = `file:${template}`;
  await withReleaseLease(() => migrateQuarterStorage(init), init);
  await init.$disconnect(); process.env.DATABASE_URL = originalUrl;
}, 60_000);
beforeEach(() => {
  const file = path.join(root, `${randomUUID()}.db`); fs.copyFileSync(template, file);
  process.env.DATABASE_URL = `file:${file}`; db = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
});
afterEach(async () => { await db.$disconnect(); process.env.DATABASE_URL = originalUrl; });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe.each(["prepared", "active"])("Nieves %s importer", phase => {
  beforeEach(async () => { if (phase === "active") await db.$executeRawUnsafe("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=? WHERE id=1", +now); });

  it("fills both overlapping workers without duplicate seats or minutes outside their shifts", async () => {
    await load([{ id: "Alma", end: 180 }, { id: "Beto", start: 60, end: 240 }]);
    const rows = await work(), atNoon = rows.filter(s => s.startMs <= ten + 120 * minute && s.endMs > ten + 120 * minute);
    expect(atNoon.map(s => s.stationId).sort()).toEqual(["nieves", "nieves2"]);
    expect(atNoon.map(s => s.seatNumber).sort()).toEqual([1, 2]);
    expect(rows.reduce((n, s) => n + s.endMs - s.startMs, 0) / minute).toBe(360);
    for (const s of rows) { const shift = (await world()).sources.find(x => x.id === s.shiftId)!; expect(s.startMs).toBeGreaterThanOrEqual(+shift.startAt); expect(s.endMs).toBeLessThanOrEqual(+shift.endAt); }
  });

  it("reuses the first seat for nonoverlapping shifts and keeps split identities", async () => {
    await load([{ id: "Alma" }, { id: "Alma", start: 120, end: 180 }, { id: "Beto", start: 60, end: 120 }]);
    const rows = await work(); expect(new Set(rows.map(s => s.stationId))).toEqual(new Set(["nieves"]));
    expect(new Set(rows.map(s => s.shiftId)).size).toBe(3);
    expect(rows.reduce((n, s) => n + s.endMs - s.startMs, 0) / minute).toBe(180);
  });

  it("honors factual partial overlap and reports the legacy hourly capacity limit", async () => {
    const result = await load([{ id: "Alma", start: 10, end: 35 }, { id: "Beto", start: 20, end: 45 }, { id: "Celia", start: 35, end: 50 }]);
    const rows = await work();
    if (phase === "active") expect(rows.reduce((n, s) => n + s.endMs - s.startMs, 0) / minute).toBe(65);
    else expect(result.fixedSkipped).toHaveLength(1);
    const shifts = (await world()).sources;
    for (const s of rows) { const shift = shifts.find(x => x.id === s.shiftId)!; expect(s.startMs).toBeGreaterThanOrEqual(+shift.startAt); expect(s.endMs).toBeLessThanOrEqual(+shift.endAt); }
  });

  it("identifies the third worker and exact unplaced interval", async () => {
    const result = await load([{ id: "Alma" }, { id: "Beto" }, { id: "Celia" }]);
    const rows = await work(), seated = new Set(rows.map(s => s.shiftId)); expect(seated.size).toBe(2);
    const missing = (await world()).sources.find(s => !seated.has(s.id))!;
    expect(result.fixedSkipped!.every(s => s.shiftId === missing.id && s.workerName?.endsWith(" Synthetic") && s.date === date)).toBe(true);
    expect(result.fixedSkipped!.reduce((n, s) => n + Date.parse(s.endAt!) - Date.parse(s.startAt!), 0) / minute).toBe(60);
  });

  it.each(["missing", "forbidden"])("keeps an %s second seat unavailable", async unavailable => {
    if (unavailable === "missing") await db.station.delete({ where: { id: "nieves2" } });
    else for (const id of ["Alma", "Beto"]) {
      await db.employee.create({ data: { id, externalId: id, firstName: id, lastName: "Synthetic" } });
      await db.employeeStationAbility.create({ data: { employeeId: id, stationId: "nieves2", level: "forbidden" } });
    }
    const result = await load([{ id: "Alma" }, { id: "Beto" }]);
    expect(new Set((await work()).map(s => s.stationId))).toEqual(new Set(["nieves"]));
    expect(new Set((await work()).map(s => s.employeeId)).size).toBe(1); expect(result.fixedSkipped!.length).toBeGreaterThan(0);
  });

  it("uses the eligible second seat when the first is forbidden", async () => {
    await db.employee.create({ data: { id: "Alma", externalId: "Alma", firstName: "Alma", lastName: "Synthetic" } });
    await db.employeeStationAbility.create({ data: { employeeId: "Alma", stationId: "nieves", level: "forbidden" } });
    await load([{ id: "Alma" }]); expect(new Set((await work()).map(s => s.stationId))).toEqual(new Set(["nieves2"]));
  });

  it.each([null, "nieves2", "green1"])("preserves the explicit mapping %s", async stationId => {
    await db.positionStationMap.update({ where: { position: NIEVES_POSITION }, data: { stationId } });
    await load([{ id: "Alma" }, { id: "Beto" }]);
    expect(new Set((await work()).map(s => s.stationId))).toEqual(new Set(stationId ? [stationId] : []));
    expect(new Set((await work()).map(s => s.employeeId)).size).toBe(stationId ? 1 : 0);
  });

  it("duplicate/replay and revised imports retain original seats and numbers", async () => {
    const rows = [{ id: "Alma" }, { id: "Beto" }]; await load(rows); const before = await signature();
    if (phase === "prepared") await expect(load(rows)).rejects.toMatchObject({ code: "DUPLICATE" });
    else expect(await load(rows)).toMatchObject({ replayed: true });
    expect(await signature()).toEqual(before);
    await load([...rows, { id: "Celia", start: 120, end: 180 }]);
    const existingIds = new Set(before.map(s => s[0])); expect((await signature()).filter(s => existingIds.has(s[0]))).toEqual(before);
  });

  it("preserves a manager erasure and reassignment while filling new extension hours", async () => {
    await load([{ id: "Alma", end: 120 }, { id: "Beto", end: 120 }]);
    await edit(phase, "Alma", 10, null); await edit(phase, "Beto", 11, "green1");
    const before = await signature(); await load([{ id: "Alma", end: 180 }, { id: "Beto", end: 180 }]);
    expect((await signature()).filter(s => Number(s[1]) < ten + 120 * minute)).toEqual(before);
    expect((await work()).filter(s => s.startMs >= ten + 120 * minute).reduce((n, s) => n + s.endMs - s.startMs, 0) / minute).toBe(120);
  });

  it("a partial extension never fills old blank minutes", async () => {
    await load([{ id: "Alma", start: 10, end: 30 }]);
    // Persist an erasure across the entire old factual interval.
    await edit(phase, "Alma", 10, null, 10, [0, 15]);
    await load([{ id: "Alma", start: 10, end: 45 }]);
    const rows = await work();
    expect(rows.every(s => s.startMs >= ten + 30 * minute)).toBe(true);
    expect(rows.reduce((n, s) => n + s.endMs - s.startMs, 0) / minute).toBe(phase === "active" ? 15 : 0);
  });

  it("keeps saved BREAK/cover bytes and removed shifts unchanged during a revision", async () => {
    const rows = [{ id: "Alma", end: 180 }, { id: "Beto", end: 180 }]; await load(rows);
    const a = await source("Alma"), b = await source("Beto");
    const booking = await db.staffBreak.create({ data: { employeeId: a.employeeId, shiftId: a.id, board: "caja", date,
      startAt: new Date(ten + 60 * minute), endAt: new Date(ten + 90 * minute), actor: "Synthetic", coverEmployeeId: b.employeeId, coverShiftId: b.id } });
    const before = await signature(); await load([...rows, { id: "Celia", start: 240, end: 300 }]);
    expect(await db.staffBreak.findUnique({ where: { id: booking.id } })).toEqual(booking);
    expect((await signature()).filter(s => s[0] === a.id || s[0] === b.id)).toEqual(before);
    await db.staffBreak.delete({ where: { id: booking.id } });
    if (phase === "active") {
      const w = await world(), current = w.sources.find(s => s.id === a.id)!;
      await removeRestoreV2({ protocol: 2, requestId: randomUUID(), capabilitySha256: CAPABILITY_SHA256,
        operation: "remove", board: "caja", date, shiftId: a.id, reason: "Synthetic manager removal",
        expected: { databaseEpoch: w.state!.databaseEpoch, worldRevision: w.revision!,
          sourceSha256: digest(sourceSnapshot(current)), removalRevision: 0 } },
      { id: "synthetic-manager", name: "Synthetic" }, now, db);
    } else await db.shift.update({ where: { id: a.id }, data: { boardRemoved: true } });
    await load([...rows, { id: "Celia", start: 240, end: 360 }]);
    expect((await db.shift.findUnique({ where: { id: a.id } }))!.boardRemoved).toBe(true);
    expect((await work()).some(s => s.shiftId === a.id)).toBe(false);
  });
});
