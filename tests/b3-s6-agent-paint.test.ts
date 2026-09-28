/**
 * B3 S6: agent colour edits through the host script, with no SSH.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  AGENT_PAINT_TEXT,
  AgentPaintExit,
  packetSha256,
  parseAgentPaintArgs,
  runAgentPaint,
  type ResolvedPacket,
} from "@/lib/agent-paint";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { acquireReleaseLock, releaseReleaseLock } from "@/lib/release-lock";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const date = "2036-08-11";
const stamp = "s6agt";
const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const LEVEL_WORD = /\b(forbidden|training|ok|preferred)\b/i;
const nia = { id: `${stamp}-nia`, shift: `${stamp}-nia-shift` };
const cam = { id: `${stamp}-cam`, shift: `${stamp}-cam-shift` };
const ids = [nia.id, cam.id];

let appDir = "";
let tempRoot = "";

function request(edits: unknown[], release = RELEASE, agent = "Lane"): string {
  return JSON.stringify({ version: 1, release, board: "cocina", date, agent, edits });
}

function stationEdit(employeeId: string, hour: number, stationId: string) {
  return { employeeId, hour, stationId };
}

function expectClean(result: { stdout: string; stderr: string }) {
  expect(`${result.stdout}${result.stderr}`).not.toMatch(LEVEL_WORD);
}

function bodyOf(result: { stdout: string; stderr: string }): Record<string, unknown> {
  return JSON.parse(result.stdout || result.stderr) as Record<string, unknown>;
}

async function counts() {
  return {
    assignments: await prisma.assignment.count({ where: { employeeId: { in: ids } } }),
    logs: await prisma.boardChangeLog.count({ where: { managerId: { startsWith: "agent:" } } }),
  };
}

async function reset() {
  await prisma.boardChangeLog.deleteMany({ where: { managerId: { startsWith: "agent:" } } });
  await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
  await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: ids } } });
}

describe("B3 S6 agent paint seams", () => {
  const packet: ResolvedPacket = {
    version: 1,
    release: RELEASE,
    board: "cocina",
    date,
    agent: "Lane",
    edits: [{
      employeeId: nia.id,
      hour: 12,
      shiftId: nia.shift,
      expectedShift: {
        startAt: "2036-08-11T14:00:00.000Z",
        endAt: "2036-08-11T22:00:00.000Z",
        employeeId: nia.id,
        sourcePosition: "Cocina",
      },
      expected: null,
      stationId: "pdf_tq1r",
    }],
  };

  it("parses preflight as the default and rejects a bad apply flag", () => {
    expect(parseAgentPaintArgs([]).mode).toBe("preflight");
    expect(parseAgentPaintArgs(["--apply", "ab".repeat(32)]).applySha).toHaveLength(64);
    expect(() => parseAgentPaintArgs(["--apply"])).toThrow(AgentPaintExit);
  });

  it("F5 apply checks the release after the lock, then resolves, validates, and paints", async () => {
    const order: string[] = [];
    const sha = packetSha256(packet);
    const result = await runAgentPaint({
      raw: JSON.stringify(packet),
      mode: "apply",
      applySha: sha,
      appDir: "/tmp/s6-seam",
    }, {
      acquireLock: async () => { order.push("lock"); return true; },
      readReleaseSha: async () => { order.push("release"); return RELEASE; },
      releaseLock: async () => { order.push("unlock"); },
      resolve: async (value) => { order.push("resolve"); return value; },
      validate: async () => { order.push("validate"); return { ok: true, saved: 1 }; },
      paint: async () => { order.push("paint"); return { ok: true, saved: 1 }; },
    });
    expect(result.code).toBe(0);
    expect(order).toEqual(["lock", "release", "resolve", "validate", "paint", "unlock"]);
    expectClean(result);
  });

  it("F5 a release mismatch after the lock does not paint, and a held lock stops first", async () => {
    const sha = packetSha256(packet);
    const mismatch: string[] = [];
    const refused = await runAgentPaint({
      raw: JSON.stringify(packet),
      mode: "apply",
      applySha: sha,
      appDir: "/tmp/s6-seam",
    }, {
      acquireLock: async () => { mismatch.push("lock"); return true; },
      readReleaseSha: async () => { mismatch.push("release"); return "b".repeat(40); },
      releaseLock: async () => { mismatch.push("unlock"); },
      resolve: async () => { mismatch.push("resolve"); return packet; },
      validate: async () => { mismatch.push("validate"); return { ok: true, saved: 1 }; },
      paint: async () => { mismatch.push("paint"); return { ok: true, saved: 1 }; },
    });
    expect(refused.code).toBe(4);
    expect(mismatch).toEqual(["lock", "release", "unlock"]);

    const held: string[] = [];
    const blocked = await runAgentPaint({
      raw: JSON.stringify(packet),
      mode: "apply",
      applySha: sha,
      appDir: "/tmp/s6-seam",
    }, {
      acquireLock: async () => { held.push("lock"); return false; },
      readReleaseSha: async () => { held.push("release"); return RELEASE; },
      releaseLock: async () => { held.push("unlock"); },
      paint: async () => { held.push("paint"); return { ok: true, saved: 1 }; },
    });
    expect(blocked.code).toBe(1);
    expect(held).toEqual(["lock"]);
    expectClean(refused);
    expectClean(blocked);
  });
});

describe("B3 S6 agent paint", () => {
  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s6-paint-"));
    appDir = path.join(tempRoot, "app");
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, "RELEASE_SHA"), `${RELEASE}\n`);
    for (const id of ["pdf_tq1r", "pdf_tq2r", "pdf_tq3r"]) {
      await prisma.station.upsert({
        where: { id },
        create: { id, board: "cocina", label: id, color: "pink", maxConcurrent: 1, sortOrder: 3 },
        update: { board: "cocina", maxConcurrent: 1 },
      });
    }
    await prisma.employee.createMany({
      data: [
        { id: nia.id, externalId: nia.id, firstName: "Nia", lastName: "Moss" },
        { id: cam.id, externalId: cam.id, firstName: "Cam", lastName: "Moss" },
      ],
    });
    const startAt = chicagoDateTime(date, "9:00 am");
    const endAt = chicagoDateTime(date, "5:00 pm");
    await prisma.shift.createMany({
      data: [nia, cam].map((person) => ({
        id: person.shift,
        employeeId: person.id,
        board: "cocina",
        date,
        sourcePosition: "Cocina",
        startAt,
        endAt,
      })),
    });
  });

  afterAll(async () => {
    if (appDir) await releaseReleaseLock(appDir, process.pid);
    await prisma.boardChangeLog.deleteMany({ where: { managerId: { startsWith: "agent:" } } });
    await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.shift.deleteMany({ where: { id: { in: [nia.shift, cam.shift] } } });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("F1 preflight resolves the shift and expected cell, writes nothing, and keeps a stable SHA", async () => {
    await reset();
    const before = await counts();
    const first = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq1r")]),
      mode: "preflight",
      appDir,
    });
    const second = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq1r")]),
      mode: "preflight",
      appDir,
    });
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const body = bodyOf(first) as { sha256: string; packet: ResolvedPacket; cells: unknown[] };
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sha256).toBe(bodyOf(second).sha256);
    expect(body.sha256).toBe(packetSha256(body.packet));
    expect(body.packet.edits[0]).toMatchObject({
      employeeId: nia.id,
      hour: 12,
      shiftId: nia.shift,
      stationId: "pdf_tq1r",
      expected: null,
    });
    expect(body.cells).toEqual([
      { employeeId: nia.id, name: "Nia Moss", hour: 12, before: null, after: "pdf_tq1r" },
    ]);
    expect(await counts()).toEqual(before);
    expectClean(first);

    const wrong = await runAgentPaint({
      raw: JSON.stringify(body.packet),
      mode: "apply",
      applySha: "0".repeat(64),
      appDir,
    });
    expect(wrong.code).toBe(3);
    expect(bodyOf(wrong).detail).toBe(AGENT_PAINT_TEXT.sha);
    expect(await counts()).toEqual(before);
    expectClean(wrong);
  });

  it("F1 a family edit previews the concrete station and writes nothing", async () => {
    await reset();
    const result = await runAgentPaint({
      raw: request([{ employeeId: nia.id, hour: 13, family: "taquero" }]),
      mode: "preflight",
      appDir,
    });
    expect(result.code).toBe(0);
    const body = bodyOf(result) as { sha256: string; packet: ResolvedPacket; cells: { family?: string; after: string | null }[] };
    expect(body.sha256).toBe(packetSha256(body.packet));
    expect(body.packet.edits[0]?.family).toBeUndefined();
    expect(body.packet.edits[0]?.stationId).toBe("pdf_tq1r");
    expect(body.cells[0]).toMatchObject({ family: "taquero", after: "pdf_tq1r", name: "Nia Moss" });
    expect((await counts()).assignments).toBe(0);
    expectClean(result);
  });

  it("F1 a split shift resolves each covered hour and refuses the gap", async () => {
    const rio = { id: `${stamp}-rio`, early: `${stamp}-rio-early`, late: `${stamp}-rio-late` };
    await prisma.employee.create({
      data: { id: rio.id, externalId: rio.id, firstName: "Rio", lastName: "Moss" },
    });
    await prisma.shift.createMany({
      data: [
        {
          id: rio.early,
          employeeId: rio.id,
          board: "cocina",
          date,
          sourcePosition: "Cocina",
          startAt: chicagoDateTime(date, "9:00 am"),
          endAt: chicagoDateTime(date, "12:00 pm"),
        },
        {
          id: rio.late,
          employeeId: rio.id,
          board: "cocina",
          date,
          sourcePosition: "Cocina",
          startAt: chicagoDateTime(date, "3:00 pm"),
          endAt: chicagoDateTime(date, "6:00 pm"),
        },
      ],
    });
    try {
      const before = await counts();
      const covered = await runAgentPaint({
        raw: request([
          stationEdit(rio.id, 10, "pdf_tq1r"),
          stationEdit(rio.id, 15, "pdf_tq2r"),
        ]),
        mode: "preflight",
        appDir,
      });
      expect(covered.code).toBe(0);
      const body = bodyOf(covered) as { packet: ResolvedPacket };
      expect(body.packet.edits.map((edit) => ({ hour: edit.hour, shiftId: edit.shiftId }))).toEqual([
        { hour: 10, shiftId: rio.early },
        { hour: 15, shiftId: rio.late },
      ]);
      const gap = await runAgentPaint({
        raw: request([stationEdit(rio.id, 13, "pdf_tq1r")]),
        mode: "preflight",
        appDir,
      });
      expect(gap.code).toBe(2);
      expect(bodyOf(gap).detail).toBe(AGENT_PAINT_TEXT.offShift);
      expect(await counts()).toEqual(before);
      expect(await prisma.assignment.count({ where: { employeeId: rio.id } })).toBe(0);
      expectClean(covered);
      expectClean(gap);
    } finally {
      await prisma.assignment.deleteMany({ where: { employeeId: rio.id } });
      await prisma.shift.deleteMany({ where: { id: { in: [rio.early, rio.late] } } });
      await prisma.employee.deleteMany({ where: { id: rio.id } });
    }
  });

  it("F2 apply saves one change-log row and a numbered seat in the paint transaction", async () => {
    await reset();
    const pre = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq1r")]),
      mode: "preflight",
      appDir,
    });
    const preview = bodyOf(pre) as { sha256: string; packet: unknown };
    const applied = await runAgentPaint({
      raw: JSON.stringify(preview.packet),
      mode: "apply",
      applySha: preview.sha256,
      appDir,
    });
    expect(applied.code).toBe(0);
    expect(bodyOf(applied)).toMatchObject({ mode: "apply", sha256: preview.sha256, saved: 1 });
    const row = await prisma.assignment.findFirstOrThrow({ where: { employeeId: nia.id } });
    expect(row.stationId).toBe("pdf_tq1r");
    expect(row.seatNumber).toBe(1);
    const logs = await prisma.boardChangeLog.findMany({ where: { managerId: "agent:Lane" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      managerName: "Agente Lane",
      route: BOARD_CHANGE_ROUTES.agentPaint,
      date,
    });
    expect(logs[0]?.route).toBe("script agent-paint");
    expectClean(applied);
  });

  it("F2 erase clears the cell and writes one row", async () => {
    await reset();
    await prisma.assignment.create({
      data: {
        shiftId: nia.shift,
        employeeId: nia.id,
        stationId: "pdf_tq1r",
        hourStart: chicagoHourStart(date, 12),
        hourEnd: chicagoHourEnd(date, 12),
        seatNumber: 1,
      },
    });
    const pre = await runAgentPaint({
      raw: request([{ employeeId: nia.id, hour: 12, erase: true }]),
      mode: "preflight",
      appDir,
    });
    expect(pre.code).toBe(0);
    const preview = bodyOf(pre) as { sha256: string; packet: unknown; cells: { before: string; after: null }[] };
    expect(preview.cells[0]).toMatchObject({ before: "pdf_tq1r", after: null, name: "Nia Moss" });
    const applied = await runAgentPaint({
      raw: JSON.stringify(preview.packet),
      mode: "apply",
      applySha: preview.sha256,
      appDir,
    });
    expect(applied.code).toBe(0);
    expect(await prisma.assignment.count({ where: { employeeId: nia.id } })).toBe(0);
    expect(await prisma.boardChangeLog.count({ where: { managerName: "Agente Lane", route: "script agent-paint" } })).toBe(1);
    expectClean(pre);
    expectClean(applied);
  });

  it("F3 a taken seat, a blocked person, an off-shift hour, and a stale board exit 2 with nothing new written", async () => {
    await reset();
    const open = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq1r")]),
      mode: "preflight",
      appDir,
    });
    const preview = bodyOf(open) as { sha256: string; packet: ResolvedPacket };
    await prisma.assignment.create({
      data: {
        shiftId: cam.shift,
        employeeId: cam.id,
        stationId: "pdf_tq1r",
        hourStart: chicagoHourStart(date, 12),
        hourEnd: chicagoHourEnd(date, 12),
      },
    });
    const taken = await runAgentPaint({
      raw: JSON.stringify(preview.packet),
      mode: "apply",
      applySha: preview.sha256,
      appDir,
    });
    expect(taken.code).toBe(2);
    expect(bodyOf(taken).detail).toBe(AGENT_PAINT_TEXT.taken);
    expect(await prisma.assignment.count({ where: { employeeId: nia.id } })).toBe(0);
    expect(await prisma.boardChangeLog.count({ where: { managerId: "agent:Lane" } })).toBe(0);
    await prisma.assignment.deleteMany({ where: { employeeId: cam.id } });

    const allowed = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq2r")]),
      mode: "preflight",
      appDir,
    });
    const allowedBody = bodyOf(allowed) as { sha256: string; packet: unknown };
    await prisma.employeeStationAbility.create({
      data: { employeeId: nia.id, stationId: "pdf_tq2r", level: "forbidden" },
    });
    const blocked = await runAgentPaint({
      raw: JSON.stringify(allowedBody.packet),
      mode: "apply",
      applySha: allowedBody.sha256,
      appDir,
    });
    expect(blocked.code).toBe(2);
    expect(bodyOf(blocked).detail).toBe(AGENT_PAINT_TEXT.blocked);
    expect(await prisma.assignment.count({ where: { employeeId: nia.id } })).toBe(0);
    expect(await prisma.boardChangeLog.count({ where: { managerId: "agent:Lane" } })).toBe(0);
    expectClean(blocked);

    const outside = await runAgentPaint({
      raw: request([stationEdit(nia.id, 7, "pdf_tq2r")]),
      mode: "preflight",
      appDir,
    });
    expect(outside.code).toBe(2);
    expect(bodyOf(outside).detail).toBe(AGENT_PAINT_TEXT.offShift);
    expectClean(outside);

    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: nia.id } });
    const fresh = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq1r")]),
      mode: "preflight",
      appDir,
    });
    const freshBody = bodyOf(fresh) as { sha256: string; packet: unknown };
    await prisma.assignment.create({
      data: {
        shiftId: nia.shift,
        employeeId: nia.id,
        stationId: "pdf_tq3r",
        hourStart: chicagoHourStart(date, 12),
        hourEnd: chicagoHourEnd(date, 12),
      },
    });
    const stale = await runAgentPaint({
      raw: JSON.stringify(freshBody.packet),
      mode: "apply",
      applySha: freshBody.sha256,
      appDir,
    });
    expect(stale.code).toBe(2);
    expect(bodyOf(stale).detail).toBe(AGENT_PAINT_TEXT.stale);
    expect(await prisma.assignment.count({ where: { employeeId: nia.id, stationId: "pdf_tq3r" } })).toBe(1);
    expect(await prisma.assignment.count({ where: { employeeId: nia.id, stationId: "pdf_tq1r" } })).toBe(0);
    expect(await prisma.boardChangeLog.count({ where: { managerId: "agent:Lane" } })).toBe(0);

    await reset();
    const family = await runAgentPaint({
      raw: request([{ employeeId: nia.id, hour: 14, family: "taquero" }]),
      mode: "preflight",
      appDir,
    });
    expect(family.code).toBe(0);
    const familyBody = bodyOf(family) as { sha256: string; packet: ResolvedPacket };
    const familyStation = familyBody.packet.edits[0]?.stationId;
    expect(familyStation).toBe("pdf_tq1r");
    expect(familyBody.packet.edits[0]?.family).toBeUndefined();
    await prisma.assignment.create({
      data: {
        shiftId: cam.shift,
        employeeId: cam.id,
        stationId: familyStation!,
        hourStart: chicagoHourStart(date, 14),
        hourEnd: chicagoHourEnd(date, 14),
      },
    });
    const familyTaken = await runAgentPaint({
      raw: JSON.stringify(familyBody.packet),
      mode: "apply",
      applySha: familyBody.sha256,
      appDir,
    });
    expect(familyTaken.code).toBe(2);
    expect(bodyOf(familyTaken).detail).toBe(AGENT_PAINT_TEXT.taken);
    expect(await prisma.assignment.count({ where: { employeeId: nia.id } })).toBe(0);
    expect(await prisma.assignment.count({ where: { stationId: "pdf_tq2r", hourStart: chicagoHourStart(date, 14) } })).toBe(0);
    expect(await prisma.boardChangeLog.count({ where: { managerId: "agent:Lane" } })).toBe(0);
    expectClean(taken);
    expectClean(stale);
    expectClean(family);
    expectClean(familyTaken);
  });

  it("F4 a different release exits 4 and a malformed packet exits 3", async () => {
    await reset();
    const before = await counts();
    const wrongRelease = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq1r")], "a".repeat(40)),
      mode: "preflight",
      appDir,
    });
    expect(wrongRelease.code).toBe(4);
    expect(bodyOf(wrongRelease).detail).toBe(AGENT_PAINT_TEXT.release);
    const malformed = await runAgentPaint({ raw: "{", mode: "preflight", appDir });
    expect(malformed.code).toBe(3);
    expect(bodyOf(malformed).detail).toBe(AGENT_PAINT_TEXT.packet);
    const empty = await runAgentPaint({ raw: JSON.stringify({ version: 1 }), mode: "apply", applySha: "ab".repeat(32), appDir });
    expect(empty.code).toBe(3);
    expect(await counts()).toEqual(before);
    expectClean(wrongRelease);
    expectClean(malformed);
  });

  it("F5 output has no ability-level word, and apply refuses while the release lock is held", async () => {
    await reset();
    await prisma.employeeStationAbility.create({
      data: { employeeId: nia.id, stationId: "pdf_tq1r", level: "forbidden" },
    });
    const blocked = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq1r")]),
      mode: "preflight",
      appDir,
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stdout).toBe("");
    expectClean(blocked);
    expect(await prisma.assignment.count({ where: { employeeId: nia.id } })).toBe(0);

    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: nia.id } });
    const pre = await runAgentPaint({
      raw: request([stationEdit(nia.id, 12, "pdf_tq1r")]),
      mode: "preflight",
      appDir,
    });
    expect(pre.code).toBe(0);
    expectClean(pre);
    const preview = bodyOf(pre) as { sha256: string; packet: unknown };
    const held = await acquireReleaseLock(appDir, process.pid, {}, 0);
    expect(held).toBe(true);
    try {
      const applied = await runAgentPaint({
        raw: JSON.stringify(preview.packet),
        mode: "apply",
        applySha: preview.sha256,
        appDir,
      });
      expect(applied.code).toBe(1);
      expect(bodyOf(applied).detail).toBe(AGENT_PAINT_TEXT.lock);
      expect(await prisma.assignment.count({ where: { employeeId: nia.id } })).toBe(0);
      expect(await prisma.boardChangeLog.count({ where: { managerId: "agent:Lane" } })).toBe(0);
      expectClean(applied);
    } finally {
      await releaseReleaseLock(appDir, process.pid);
    }
  });
});
