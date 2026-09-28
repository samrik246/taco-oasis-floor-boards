/**
 * B3 S11: column look settings, Nuevos no, and the install seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PUT as saveColumn } from "@/app/api/admin/ability-columns/route";
import { GET as abilityGrid } from "@/app/api/admin/abilities/route";
import { GET as dayBoard } from "@/app/api/boards/[board]/days/[date]/route";
import { AGENT_PAINT_TEXT, runAgentPaint } from "@/lib/agent-paint";
import { ABILITY_COLUMN_INSTALL_SEED, ABILITY_OK_RESET_STATIONS, seedAbilityColumnSettings } from "@/lib/abilities/column-settings";
import { cellLevel } from "@/lib/abilities/levels";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import { paintAssignments } from "@/lib/assignments/paint";
import { copyDayAssignments, createAssignment } from "@/lib/assignments/service";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { commitImport, previewImport } from "@/lib/import/persist-import";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { eligibilityDots } from "@/lib/mandatory";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { seedDemoScheduleAssignments } from "@/lib/schedule/seed-demo-assignments";
import { removeShift, restoreShift } from "@/lib/shifts/remove-restore";
import { ALL_STATIONS } from "@/lib/stations";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { chicagoDateTime } from "@/lib/time";
import { syntheticCsv, type SyntheticRow } from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();
const stamp = `b3s11-${Date.now()}`;
const sourceDate = "2038-04-04";
const targetDate = "2038-04-05";
const RELEASE = "abcdef0123456789abcdef0123456789abcdef01";
const root = path.resolve(__dirname, "..");

let ownerToken = "";
let managerToken = "";
let ownerId = "";
let ownerName = "";

function authed(token: string | null, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (token) headers.set("x-manager-session", token);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Request(url, { ...init, headers });
}

function putColumn(token: string | null, body: unknown) {
  return saveColumn(authed(token, "http://local/api/admin/ability-columns", {
    method: "PUT",
    body: JSON.stringify(body),
  }));
}

describe("B3 S11 column default helper", () => {
  it("a missing row stays ok unless the column default is no, and a saved row wins", () => {
    expect(levelWhenUnset(undefined, undefined)).toBeNull();
    expect(levelWhenUnset(undefined, "ok")).toBeNull();
    expect(levelWhenUnset(undefined, "forbidden")).toBe("forbidden");
    expect(levelWhenUnset("preferred", "forbidden")).toBe("preferred");
    expect(cellLevel(["pdf_pstl"], [], new Map([["pdf_pstl", "forbidden"]]))).toBe("forbidden");
    expect(cellLevel(["pdf_pstl"], [{ stationId: "pdf_pstl", level: "ok" }], new Map([["pdf_pstl", "forbidden"]]))).toBe("ok");
    const gaps = [{ stationId: "pdf_pstl", hour: 12 }];
    const shift = { employee: { abilities: [] as { stationId: string; level: string }[] } };
    expect(eligibilityDots({
      gaps, shift, hour: 12, kind: "open",
      columnDefaults: new Map([["pdf_pstl", "forbidden"]]),
    })).toEqual([]);
    expect(eligibilityDots({
      gaps,
      shift: { employee: { abilities: [{ stationId: "pdf_pstl", level: "preferred" }] } },
      hour: 12,
      kind: "open",
      columnDefaults: new Map([["pdf_pstl", "forbidden"]]),
    })).toEqual([{ stationId: "pdf_pstl", dim: false }]);
    expect(eligibilityDots({ gaps, shift, hour: 12, kind: "open" })).toEqual([
      { stationId: "pdf_pstl", dim: false },
    ]);
  });
});

describe("B3 S11 column settings", () => {
  afterAll(async () => {
    await prisma.abilityColumnSetting.deleteMany({
      where: { key: { in: ABILITY_COLUMN_INSTALL_SEED.map((row) => row.key) } },
    });
    if (ownerId) await prisma.boardChangeLog.deleteMany({ where: { managerId: ownerId } });
    const people = await prisma.employee.findMany({
      where: { externalId: { startsWith: stamp } },
      select: { id: true },
    });
    const ids = people.map((person) => person.id);
    if (ids.length > 0) {
      await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.manager.deleteMany({ where: { name: { startsWith: stamp } } });
    await prisma.$disconnect();
  });

  it("L2 a manager is refused, and the day read never carries the settings", async () => {
    const owner = await prisma.manager.create({
      data: { name: `${stamp} Owner`, codeHash: hashManagerCode(`${stamp}-owner`), role: "owner" },
    });
    const manager = await prisma.manager.create({
      data: { name: `${stamp} Manager`, codeHash: hashManagerCode(`${stamp}-manager`), role: "manager" },
    });
    ownerId = owner.id;
    ownerName = owner.name;
    ownerToken = signManagerSession({ id: owner.id, name: owner.name });
    managerToken = signManagerSession({ id: manager.id, name: manager.name });

    expect((await putColumn(null, { key: "pdf_pstl", hidden: true })).status).toBe(401);
    expect((await putColumn(managerToken, { key: "pdf_pstl", hidden: true })).status).toBe(403);
    const managerGrid = await abilityGrid(authed(managerToken, "http://local/api/admin/abilities?board=cocina"));
    expect(managerGrid.status).toBe(403);
    expect(JSON.stringify(await managerGrid.json())).not.toContain("defaultLevel");

    const hidden = await putColumn(ownerToken, { key: "pdf_pstl", hidden: true });
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toEqual({ changed: true });
    const again = await putColumn(ownerToken, { key: "pdf_pstl", hidden: true });
    expect(await again.json()).toEqual({ changed: false });
    const shown = await putColumn(ownerToken, { key: "pdf_pstl", hidden: false });
    expect(shown.status).toBe(200);
    const grid = await abilityGrid(authed(ownerToken, "http://local/api/admin/abilities?board=cocina"));
    const body = await grid.json() as { settings: { key: string; hidden: boolean }[] };
    expect(body.settings.find((row) => row.key === "pdf_pstl")).toMatchObject({ hidden: false });

    const day = await dayBoard(
      authed(managerToken, `http://local/api/boards/cocina/days/${sourceDate}`),
      { params: Promise.resolve({ board: "cocina", date: sourceDate }) },
    );
    const dayBody = await day.json() as Record<string, unknown>;
    expect(dayBody).not.toHaveProperty("settings");
    expect(JSON.stringify(dayBody)).not.toContain("defaultLevel");
    expect(JSON.stringify(dayBody)).not.toContain("ability-columns");
  });

  it("L3 an unticked person is refused at paint, copy-day and assign, and a ticked person keeps ok", async () => {
    const person = await prisma.employee.create({
      data: { externalId: `${stamp}-ada`, firstName: "Ada", lastName: "Moss" },
    });
    const startAt = chicagoDateTime(sourceDate, "9:00 am");
    const endAt = chicagoDateTime(sourceDate, "5:00 pm");
    const sourceShift = await prisma.shift.create({
      data: {
        employeeId: person.id, date: sourceDate, startAt, endAt,
        sourcePosition: "Cocina", board: "cocina",
      },
    });
    const targetShift = await prisma.shift.create({
      data: {
        employeeId: person.id, date: targetDate, startAt: chicagoDateTime(targetDate, "9:00 am"),
        endAt: chicagoDateTime(targetDate, "5:00 pm"), sourcePosition: "Cocina", board: "cocina",
      },
    });
    await prisma.assignment.create({
      data: {
        shiftId: sourceShift.id, employeeId: person.id, stationId: "pdf_pstl",
        hourStart: chicagoHourStart(sourceDate, 12), hourEnd: chicagoHourEnd(sourceDate, 12),
      },
    });
    expect((await putColumn(ownerToken, { key: "pdf_pstl", defaultLevel: "forbidden" })).status).toBe(200);

    const painted = await paintAssignments({
      board: "cocina",
      date: targetDate,
      edits: [{
        shiftId: targetShift.id,
        hour: 12,
        expectedShift: {
          startAt: targetShift.startAt.toISOString(),
          endAt: targetShift.endAt.toISOString(),
          employeeId: person.id,
          sourcePosition: "Cocina",
        },
        expected: null,
        stationId: "pdf_pstl",
      }],
    }, chicagoDateTime(targetDate, "8:00 am"));
    expect(painted.ok).toBe(false);
    if (!painted.ok) expect(painted.code).toBe("FORBIDDEN_ABILITY");

    const assigned = await createAssignment({
      shiftId: targetShift.id, stationId: "pdf_pstl", date: targetDate, hour: 13,
      now: chicagoDateTime(targetDate, "8:00 am"),
    });
    expect(assigned.ok).toBe(false);

    const copied = await copyDayAssignments({
      board: "cocina", sourceDate, targetDate, now: chicagoDateTime(targetDate, "8:00 am"),
    });
    expect(copied.ok).toBe(true);
    if (copied.ok) expect(copied.summary.forbidden).toBeGreaterThan(0);
    expect(await prisma.assignment.count({
      where: { employeeId: person.id, stationId: "pdf_pstl", shiftId: targetShift.id },
    })).toBe(0);

    await prisma.employeeStationAbility.create({
      data: { employeeId: person.id, stationId: "pdf_pstl", level: "ok" },
    });
    const kept = await createAssignment({
      shiftId: targetShift.id, stationId: "pdf_pstl", date: targetDate, hour: 14,
      now: chicagoDateTime(targetDate, "8:00 am"),
    });
    expect(kept.ok).toBe(true);
  });

  it("L3 agent-paint refuses an unticked person and keeps a ticked level", async () => {
    const person = await prisma.employee.create({
      data: { externalId: `${stamp}-bea`, firstName: "Bea", lastName: "Moss" },
    });
    const startAt = chicagoDateTime(sourceDate, "9:00 am");
    const endAt = chicagoDateTime(sourceDate, "5:00 pm");
    await prisma.shift.create({
      data: {
        id: `${stamp}-bea-shift`, employeeId: person.id, date: sourceDate, startAt, endAt,
        sourcePosition: "Cocina", board: "cocina",
      },
    });
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "s11-paint-"));
    fs.writeFileSync(path.join(appDir, "RELEASE_SHA"), `${RELEASE}\n`);
    const raw = JSON.stringify({
      version: 1, release: RELEASE, board: "cocina", date: sourceDate, agent: "Lane",
      edits: [{ employeeId: person.id, hour: 15, stationId: "pdf_pstl" }],
    });
    const refused = await runAgentPaint({ raw, mode: "preflight", appDir });
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr).detail).toBe(AGENT_PAINT_TEXT.blocked);

    await prisma.employeeStationAbility.create({
      data: { employeeId: person.id, stationId: "pdf_pstl", level: "preferred" },
    });
    const kept = await runAgentPaint({ raw, mode: "preflight", appDir });
    expect(kept.code).toBe(0);
    fs.rmSync(appDir, { recursive: true, force: true });
  });

  it("L3 restore replay refuses an unticked person and keeps a saved bien", async () => {
    const replayDate = "2038-04-07";
    const externalId = `${stamp}-rea`;
    expect((await putColumn(ownerToken, { key: "pdf_pstl", defaultLevel: "forbidden" })).status).toBe(200);
    const person = await prisma.employee.create({
      data: { externalId, firstName: "Rea", lastName: "Moss" },
    });
    const startAt = chicagoDateTime(replayDate, "9:00 am");
    const endAt = chicagoDateTime(replayDate, "5:00 pm");
    const shift = await prisma.shift.create({
      data: {
        employeeId: person.id, date: replayDate, startAt, endAt,
        sourcePosition: "Cocina", board: "cocina",
      },
    });
    await prisma.assignment.create({
      data: {
        shiftId: shift.id, employeeId: person.id, stationId: "pdf_pstl",
        hourStart: chicagoHourStart(replayDate, 12), hourEnd: chicagoHourEnd(replayDate, 12),
      },
    });
    const manager = { id: ownerId, name: ownerName };
    const expected = {
      startAt: startAt.toISOString(), endAt: endAt.toISOString(),
      employeeId: person.id, sourcePosition: "Cocina",
    };
    const now = chicagoDateTime(replayDate, "8:00 am");
    const removed = await removeShift({
      shiftId: shift.id, board: "cocina", date: replayDate, expected,
      expectedRevision: 0, reason: "Replay check", manager, now,
    });
    await expect(restoreShift({
      id: removed.id, expectedRevision: removed.revision, expected,
      positions: "replay", reason: "Try replay", manager, now,
    })).rejects.toMatchObject({
      code: "POSITION_CONFLICT",
      message: expect.stringContaining("FORBIDDEN_ABILITY"),
    });
    expect(await prisma.assignment.count({ where: { shiftId: shift.id } })).toBe(0);

    await prisma.employeeStationAbility.create({
      data: { employeeId: person.id, stationId: "pdf_pstl", level: "ok" },
    });
    const restored = await restoreShift({
      id: removed.id, expectedRevision: removed.revision, expected,
      positions: "replay", reason: "Saved bien", manager, now,
    });
    expect(restored.restoredCells).toBe(1);
    expect(await prisma.assignment.count({
      where: { shiftId: shift.id, stationId: "pdf_pstl" },
    })).toBe(1);
  });

  it("L3 schedule takeover refuses an unticked person and keeps a saved bien", async () => {
    const takeoverDate = "2038-04-08";
    const outgoingId = `${stamp}-out`;
    const incomingId = `${stamp}-in`;
    expect((await putColumn(ownerToken, { key: "pdf_pstl", defaultLevel: "forbidden" })).status).toBe(200);
    const now = chicagoDateTime(takeoverDate, "12:30 pm");
    const row = (employeeId: string, firstName: string): SyntheticRow => ({
      position: "Cocina", firstName, lastName: "Moss", employeeId,
      date: takeoverDate, start: "8:00 am", end: "6:00 pm",
    });
    const parse = (rows: SyntheticRow[], filename: string) =>
      parseScheduleWorkbook(syntheticCsv(rows), { filename });
    const before = await parse([row(outgoingId, "Out")], `${stamp}-before.csv`);
    await commitImport(before, `${stamp}-before.csv`, { now });
    const outgoing = await prisma.shift.findFirstOrThrow({
      where: { employee: { externalId: outgoingId }, date: takeoverDate, supersededAt: null },
    });
    await prisma.assignment.create({
      data: {
        shiftId: outgoing.id, employeeId: outgoing.employeeId, stationId: "pdf_pstl",
        hourStart: chicagoHourStart(takeoverDate, 14), hourEnd: chicagoHourEnd(takeoverDate, 14),
      },
    });
    expect(await prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId: outgoing.employeeId, stationId: "pdf_pstl" } },
    })).toMatchObject({ level: "forbidden" });

    const after = await parse([row(incomingId, "In")], `${stamp}-after.csv`);
    const preview = await previewImport(after, { now });
    expect(preview.dates[0]!.assignmentsToTransfer).toEqual([
      { board: "cocina", stationId: "pdf_pstl", hour: 14 },
    ]);
    await expect(commitImport(after, `${stamp}-after.csv`, {
      now, expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
    })).rejects.toMatchObject({
      code: "REFUSED",
      refusals: [{ code: "TAKEOVER_CONFLICT", message: expect.stringContaining("FORBIDDEN_ABILITY") }],
    });
    expect(await prisma.employee.findUnique({ where: { externalId: incomingId } })).toBeNull();
    expect(await prisma.assignment.count({ where: { shiftId: outgoing.id, stationId: "pdf_pstl" } })).toBe(1);

    const incoming = await prisma.employee.create({
      data: { externalId: incomingId, firstName: "In", lastName: "Moss" },
    });
    await prisma.employeeStationAbility.create({
      data: { employeeId: incoming.id, stationId: "pdf_pstl", level: "ok" },
    });
    const keptPreview = await previewImport(after, { now });
    await commitImport(after, `${stamp}-after.csv`, {
      now, expected: { fingerprint: keptPreview.fingerprint, planDigest: keptPreview.planDigest },
    });
    const seated = await prisma.assignment.findMany({
      where: { employeeId: incoming.id, stationId: "pdf_pstl" },
    });
    expect(seated).toHaveLength(1);
    expect(await prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId: incoming.id, stationId: "pdf_pstl" } },
    })).toMatchObject({ level: "ok" });
  });

  it("L3 the sample demo seeder skips an unticked person and keeps a saved bien", async () => {
    const demoDate = "2038-04-06";
    const externalId = `${stamp}-demo`;
    expect(fs.readFileSync(path.join(root, "src/app/api/sample/route.ts"), "utf8"))
      .toContain("seedDemoScheduleAssignments");
    expect((await putColumn(ownerToken, { key: "pdf_pstl", defaultLevel: "forbidden" })).status).toBe(200);
    const person = await prisma.employee.create({
      data: { externalId, firstName: "Dee", lastName: "Moss" },
    });
    const cocina = ALL_STATIONS.filter((station) => station.board === "cocina")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const pasteles = cocina.findIndex((station) => station.id === "pdf_pstl");
    const hourStart = chicagoHourStart(demoDate, 12);
    const hourEnd = chicagoHourEnd(demoDate, 12);
    for (const station of cocina.slice(0, pasteles)) {
      const filler = await prisma.employee.create({
        data: { externalId: `${stamp}-fill-${station.id}`, firstName: "Fill", lastName: station.id },
      });
      const fillerShift = await prisma.shift.create({
        data: {
          employeeId: filler.id, board: "cocina", date: demoDate, sourcePosition: "Cocina",
          startAt: chicagoDateTime(demoDate, "12:00 pm"),
          endAt: chicagoDateTime(demoDate, "1:00 pm"),
        },
      });
      await prisma.assignment.create({
        data: {
          shiftId: fillerShift.id, employeeId: filler.id, stationId: station.id,
          hourStart, hourEnd,
        },
      });
    }
    await prisma.shift.create({
      data: {
        employeeId: person.id, board: "cocina", date: demoDate, sourcePosition: "Cocina",
        startAt: chicagoDateTime(demoDate, "12:00 pm"),
        endAt: chicagoDateTime(demoDate, "1:00 pm"),
      },
    });
    const skipped = await seedDemoScheduleAssignments([demoDate]);
    expect(skipped.created).toBe(0);
    expect(await prisma.assignment.count({ where: { employeeId: person.id } })).toBe(0);

    await prisma.employeeStationAbility.create({
      data: { employeeId: person.id, stationId: "pdf_pstl", level: "ok" },
    });
    const kept = await seedDemoScheduleAssignments([demoDate]);
    const second = await prisma.assignment.findMany({ where: { employeeId: person.id } });
    expect(kept.created).toBe(1);
    expect(second.map((row) => row.stationId)).toEqual(["pdf_pstl"]);
  });

  it("import stores Nuevos no on a missing cocina row and keeps a saved level", async () => {
    const hireDate = "2038-04-09";
    const savedId = `${stamp}-saved`;
    const hireId = `${stamp}-hire`;
    expect((await putColumn(ownerToken, { key: "pdf_pstl", defaultLevel: "forbidden" })).status).toBe(200);
    expect((await putColumn(ownerToken, { key: "pdf_rngn", defaultLevel: "forbidden" })).status).toBe(200);
    const saved = await prisma.employee.create({
      data: { externalId: savedId, firstName: "Sav", lastName: "Moss" },
    });
    await prisma.employeeStationAbility.createMany({
      data: [
        { employeeId: saved.id, stationId: "pdf_pstl", level: "preferred" },
        { employeeId: saved.id, stationId: "pdf_rngn", level: "training" },
        { employeeId: saved.id, stationId: "pdf_tq1r", level: "ok" },
      ],
    });
    const now = chicagoDateTime(hireDate, "8:00 am");
    const row = (employeeId: string, firstName: string): SyntheticRow => ({
      position: "Cocina", firstName, lastName: "Moss", employeeId,
      date: hireDate, start: "8:00 am", end: "4:00 pm",
    });
    const parsed = await parseScheduleWorkbook(syntheticCsv([
      row(savedId, "Sav"),
      row(hireId, "Nue"),
    ]), { filename: `${stamp}-hire.csv` });
    await commitImport(parsed, `${stamp}-hire.csv`, { now });
    const hire = await prisma.employee.findUniqueOrThrow({ where: { externalId: hireId } });
    const levelAt = (employeeId: string, stationId: string) => prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId, stationId } },
    });
    expect(await levelAt(hire.id, "pdf_pstl")).toMatchObject({ level: "forbidden" });
    expect(await levelAt(hire.id, "pdf_rngn")).toMatchObject({ level: "forbidden" });
    expect(await levelAt(hire.id, "pdf_tq1r")).toMatchObject({ level: "ok" });
    expect(await levelAt(saved.id, "pdf_pstl")).toMatchObject({ level: "preferred" });
    expect(await levelAt(saved.id, "pdf_rngn")).toMatchObject({ level: "training" });
    expect(await levelAt(saved.id, "pdf_tq1r")).toMatchObject({ level: "ok" });
  });

  it("L5 the install seed rewrites bien to no on Pasteles and Relleno general only", async () => {
    expect(ABILITY_OK_RESET_STATIONS).toEqual(["pdf_pstl", "pdf_rngn"]);
    await prisma.abilityColumnSetting.deleteMany({
      where: { key: { in: ABILITY_COLUMN_INSTALL_SEED.map((row) => row.key) } },
    });
    const keeper = await prisma.employee.create({
      data: { externalId: `${stamp}-keep`, firstName: "Kay", lastName: "Moss" },
    });
    const held = await prisma.employee.create({
      data: { externalId: `${stamp}-held`, firstName: "Hal", lastName: "Moss" },
    });
    await prisma.employeeStationAbility.createMany({
      data: [
        { employeeId: keeper.id, stationId: "pdf_pstl", level: "ok" },
        { employeeId: keeper.id, stationId: "pdf_rngn", level: "ok" },
        { employeeId: keeper.id, stationId: "pdf_tq1r", level: "ok" },
        { employeeId: held.id, stationId: "pdf_pstl", level: "training" },
        { employeeId: held.id, stationId: "pdf_rngn", level: "preferred" },
        { employeeId: held.id, stationId: "green1", level: "ok" },
      ],
    });
    const before = await prisma.employeeStationAbility.findMany({
      orderBy: [{ employeeId: "asc" }, { stationId: "asc" }],
    });
    const expected = {
      pdf_pstl: before.filter((row) => row.stationId === "pdf_pstl" && row.level === "ok").length,
      pdf_rngn: before.filter((row) => row.stationId === "pdf_rngn" && row.level === "ok").length,
    };
    expect(expected.pdf_pstl).toBeGreaterThan(0);
    expect(expected.pdf_rngn).toBeGreaterThan(0);
    const actor = { id: ownerId, name: ownerName, route: BOARD_CHANGE_ROUTES.abilityColumnSeed };
    try {
      const first = await seedAbilityColumnSettings(actor);
      expect(first).toEqual({ written: 5, unchanged: 0, okToForbidden: expected });
      const rows = await prisma.abilityColumnSetting.findMany({ orderBy: { key: "asc" } });
      expect(rows.map((row) => ({ key: row.key, hidden: row.hidden, defaultLevel: row.defaultLevel }))).toEqual(
        [...ABILITY_COLUMN_INSTALL_SEED].sort((a, b) => a.key.localeCompare(b.key)),
      );
      const after = await prisma.employeeStationAbility.findMany({
        orderBy: [{ employeeId: "asc" }, { stationId: "asc" }],
      });
      expect(after.map((row) => [row.employeeId, row.stationId, row.level])).toEqual(
        before.map((row) => [
          row.employeeId,
          row.stationId,
          (row.stationId === "pdf_pstl" || row.stationId === "pdf_rngn") && row.level === "ok"
            ? "forbidden"
            : row.level,
        ]),
      );
      const resetSummary = `undated pdf_pstl=${expected.pdf_pstl} pdf_rngn=${expected.pdf_rngn}`;
      const logs = await prisma.boardChangeLog.findMany({
        where: { managerId: ownerId, route: BOARD_CHANGE_ROUTES.abilityColumnSeed },
      });
      expect(logs.filter((row) => row.summary.includes("hidden"))).toHaveLength(5);
      expect(logs.filter((row) => row.summary === resetSummary).map((row) => row.summary)).toEqual([resetSummary]);
      expect(resetSummary).not.toMatch(/Moss|Kay|Hal/);
      const second = await seedAbilityColumnSettings(actor);
      expect(second).toEqual({
        written: 0,
        unchanged: 5,
        okToForbidden: { pdf_pstl: 0, pdf_rngn: 0 },
      });
      const logsAfter = await prisma.boardChangeLog.count({
        where: { managerId: ownerId, route: BOARD_CHANGE_ROUTES.abilityColumnSeed, summary: resetSummary },
      });
      expect(logsAfter).toBe(1);
    } finally {
      for (const row of before) {
        await prisma.employeeStationAbility.update({
          where: { employeeId_stationId: { employeeId: row.employeeId, stationId: row.stationId } },
          data: { level: row.level },
        });
      }
    }
  });

  it("db push adds the column table and leaves an ability row", async () => {
    const current = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
    const start = current.indexOf("/// One Habilidades column rule.");
    const modelEnd = current.indexOf("\n}", current.indexOf("model AbilityColumnSetting")) + 2;
    expect(start).toBeGreaterThan(0);
    const old = `${current.slice(0, start)}${current.slice(modelEnd)}`;
    expect(old).not.toContain("model AbilityColumnSetting");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b3-s11-push-"));
    const dbUrl = `file:${path.join(tmp, "home-base.db")}`;
    const env = { ...process.env, DATABASE_URL: dbUrl };
    const run = (args: string[]) => execFileSync("pnpm", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });
    fs.writeFileSync(path.join(tmp, "schema.prisma"), old);
    fs.writeFileSync(path.join(tmp, "home-base.db"), "");
    const created = Date.parse("2035-04-01T00:00:00Z");
    try {
      run(["exec", "prisma", "db", "push", "--schema", path.join(tmp, "schema.prisma"), "--skip-generate"]);
      const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
      await db.$executeRawUnsafe(
        `INSERT INTO "Station" (id, board, label, color, maxConcurrent, sortOrder, priority, shortCode) VALUES ('pdf_pstl','cocina','Pasteles','purple',1,40,NULL,'')`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "Employee" (id, externalId, firstName, lastName, email, createdAt, updatedAt) VALUES ('s11e','s11e','Ada','Moss',NULL,${created},${created})`,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "EmployeeStationAbility" (employeeId, stationId, level) VALUES ('s11e','pdf_pstl','ok')`,
      );
      await db.$disconnect();
      const push = run(["exec", "prisma", "db", "push", "--skip-generate"]);
      expect(push).not.toMatch(/accept-data-loss|data loss/i);
      expect(push).toMatch(/in sync|already in sync|Your database is now in sync/i);
      const after = new PrismaClient({ datasources: { db: { url: dbUrl } } });
      const abilities = await after.$queryRawUnsafe<Array<{ employeeId: string; stationId: string; level: string }>>(
        `SELECT employeeId, stationId, level FROM "EmployeeStationAbility"`,
      );
      expect(abilities).toEqual([{ employeeId: "s11e", stationId: "pdf_pstl", level: "ok" }]);
      const tables = await after.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'AbilityColumnSetting'`,
      );
      expect(tables).toEqual([{ name: "AbilityColumnSetting" }]);
      await after.$disconnect();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
