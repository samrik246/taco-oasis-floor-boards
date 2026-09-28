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
import { ABILITY_COLUMN_INSTALL_SEED, seedAbilityColumnSettings } from "@/lib/abilities/column-settings";
import { cellLevel } from "@/lib/abilities/levels";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import { paintAssignments } from "@/lib/assignments/paint";
import { copyDayAssignments, createAssignment } from "@/lib/assignments/service";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { eligibilityDots } from "@/lib/mandatory";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { chicagoDateTime } from "@/lib/time";

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

  it("L5 the install seed writes only column settings and leaves every ability row", async () => {
    await prisma.abilityColumnSetting.deleteMany({
      where: { key: { in: ABILITY_COLUMN_INSTALL_SEED.map((row) => row.key) } },
    });
    const before = await prisma.employeeStationAbility.findMany({
      orderBy: [{ employeeId: "asc" }, { stationId: "asc" }],
    });
    const actor = { id: ownerId, name: ownerName, route: BOARD_CHANGE_ROUTES.abilityColumnSeed };
    const first = await seedAbilityColumnSettings(actor);
    expect(first).toEqual({ written: 5, unchanged: 0 });
    const rows = await prisma.abilityColumnSetting.findMany({ orderBy: { key: "asc" } });
    expect(rows.map((row) => ({ key: row.key, hidden: row.hidden, defaultLevel: row.defaultLevel }))).toEqual(
      [...ABILITY_COLUMN_INSTALL_SEED].sort((a, b) => a.key.localeCompare(b.key)),
    );
    const after = await prisma.employeeStationAbility.findMany({
      orderBy: [{ employeeId: "asc" }, { stationId: "asc" }],
    });
    expect(after).toEqual(before);
    const logs = await prisma.boardChangeLog.count({
      where: { managerId: ownerId, route: BOARD_CHANGE_ROUTES.abilityColumnSeed },
    });
    expect(logs).toBe(5);
    const second = await seedAbilityColumnSettings(actor);
    expect(second).toEqual({ written: 0, unchanged: 5 });
    expect(await prisma.employeeStationAbility.count()).toBe(before.length);
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
