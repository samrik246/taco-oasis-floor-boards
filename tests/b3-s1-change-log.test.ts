/**
 * B3 S1 change log: one row per successful write route, none on a refusal,
 * and the owner screen reads a paint row beside a shift-removal event.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PUT as assignHour } from "@/app/api/assignments/route";
import { DELETE as clearHour } from "@/app/api/assignments/[id]/route";
import { POST as copyDay } from "@/app/api/assignments/copy-day/route";
import { PUT as placeFixed } from "@/app/api/assignments/fixed/route";
import { PUT as paint } from "@/app/api/assignments/paint/route";
import { PUT as suggest } from "@/app/api/assignments/suggest/route";
import { PUT as assignShift } from "@/app/api/assignments/shift/route";
import { POST as swap } from "@/app/api/assignments/swap/route";
import { GET as listChanges } from "@/app/api/admin/changes/route";
import { POST as logMove } from "@/app/api/position-moves/route";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import * as boardChangeLog from "@/lib/board-change-log";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const stamp = `b3log-${Date.now()}`;
const date = "2031-04-08";
const nextDate = "2031-04-09";
const stationA = `${stamp}-a`;
const stationB = `${stamp}-b`;
const employeeId = `${stamp}-person`;
const otherId = `${stamp}-other`;
const prose = "do not store this prose";

let ownerToken = "";
let managerToken = "";
let ownerId = "";
let ownerName = "";
let primaryShiftId = "";
let targetShiftId = "";

function authed(token: string | null, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("x-manager-session", token);
  return new Request(url, { ...init, headers });
}

async function rowsFor(route: string) {
  return prisma.boardChangeLog.findMany({ where: { managerId: ownerId, route } });
}

describe("B3 S1 board change log", () => {
  afterAll(async () => {
    await prisma.boardChangeLog.deleteMany({ where: { managerId: ownerId } });
    await prisma.shiftRemovalEvent.deleteMany({ where: { managerId: ownerId } });
    await prisma.shiftRemoval.deleteMany({ where: { externalId: stamp } });
    await prisma.positionMoveLog.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    await prisma.assignment.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    await prisma.shift.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    await prisma.employee.deleteMany({ where: { id: { in: [employeeId, otherId] } } });
    await prisma.positionStationMap.deleteMany({ where: { position: stamp } });
    await prisma.station.deleteMany({ where: { id: { in: [stationA, stationB] } } });
    await prisma.manager.deleteMany({ where: { name: { startsWith: stamp } } });
    await prisma.$disconnect();
  });

  it("A11 each write route logs one row on success and none on a refusal", async () => {
    const owner = await prisma.manager.create({
      data: { name: `${stamp} owner`, codeHash: hashManagerCode(`${stamp}-owner`), role: "owner" },
    });
    const manager = await prisma.manager.create({
      data: { name: `${stamp} manager`, codeHash: hashManagerCode(`${stamp}-manager`), role: "manager" },
    });
    ownerId = owner.id;
    ownerName = owner.name;
    ownerToken = signManagerSession({ id: owner.id, name: owner.name });
    managerToken = signManagerSession({ id: manager.id, name: manager.name });

    const startAt = chicagoDateTime(date, "9:00 am");
    const endAt = chicagoDateTime(date, "5:00 pm");
    for (const [id, order] of [[stationA, 80], [stationB, 81]] as const) {
      await prisma.station.upsert({
        where: { id },
        create: { id, board: "caja", label: id, color: "green", maxConcurrent: 1, sortOrder: order },
        update: { board: "caja", maxConcurrent: 1 },
      });
    }
    await prisma.employee.createMany({
      data: [
        { id: employeeId, externalId: employeeId, firstName: "S1", lastName: "Painter" },
        { id: otherId, externalId: otherId, firstName: "S1", lastName: "Other" },
      ],
    });
    await prisma.employeeStationAbility.create({
      data: { employeeId, stationId: stationA, level: "preferred" },
    });
    const shift = await prisma.shift.create({
      data: {
        employeeId,
        date,
        startAt,
        endAt,
        sourcePosition: stamp,
        board: "caja",
      },
    });
    primaryShiftId = shift.id;
    const otherShift = await prisma.shift.create({
      data: {
        employeeId: otherId,
        date,
        startAt,
        endAt,
        sourcePosition: "S1 other",
        board: "caja",
      },
    });
    const targetShift = await prisma.shift.create({
      data: {
        employeeId,
        date: nextDate,
        startAt: chicagoDateTime(nextDate, "9:00 am"),
        endAt: chicagoDateTime(nextDate, "5:00 pm"),
        sourcePosition: stamp,
        board: "caja",
      },
    });
    targetShiftId = targetShift.id;
    await prisma.positionStationMap.create({ data: { position: stamp, stationId: stationA } });

    const before = await prisma.boardChangeLog.count({ where: { managerId: ownerId } });
    const refused: Array<{ name: string; status: number; run: () => Promise<Response> }> = [
      { name: "assign", status: 401, run: () => assignHour(authed(null, "http://local/api/assignments", { method: "PUT", body: "not-json" })) },
      { name: "shift", status: 401, run: () => assignShift(authed(null, "http://local/api/assignments/shift", { method: "PUT", body: "{}" })) },
      { name: "suggest", status: 401, run: () => suggest(authed(null, "http://local/api/assignments/suggest", { method: "PUT", body: "{}" })) },
      { name: "paint", status: 401, run: () => paint(authed(null, "http://local/api/assignments/paint", { method: "PUT", body: "{}" })) },
      { name: "fixed", status: 401, run: () => placeFixed(authed(null, "http://local/api/assignments/fixed", { method: "PUT", body: "{}" })) },
      { name: "swap", status: 401, run: () => swap(authed(null, "http://local/api/assignments/swap", { method: "POST", body: "{}" })) },
      { name: "copy", status: 401, run: () => copyDay(authed(null, "http://local/api/assignments/copy-day", { method: "POST", body: "{}" })) },
      {
        name: "clear",
        status: 401,
        run: () => clearHour(authed(null, "http://local/api/assignments/missing", { method: "DELETE" }), { params: Promise.resolve({ id: "missing" }) }),
      },
      { name: "move", status: 401, run: () => logMove(authed(null, "http://local/api/position-moves", { method: "POST", body: "{}" })) },
      {
        name: "assign-missing",
        status: 404,
        run: () =>
          assignHour(
            authed(ownerToken, "http://local/api/assignments", {
              method: "PUT",
              body: JSON.stringify({ shiftId: "missing", stationId: stationA, date, hour: 10, note: prose }),
            }),
          ),
      },
    ];
    for (const entry of refused) {
      const res = await entry.run();
      expect(res.status, entry.name).toBe(entry.status);
    }
    expect(await prisma.boardChangeLog.count({ where: { managerId: ownerId } })).toBe(before);

    const assigned = await assignHour(
      authed(ownerToken, "http://local/api/assignments", {
        method: "PUT",
        body: JSON.stringify({ shiftId: shift.id, stationId: stationA, date, hour: 10, note: prose }),
      }),
    );
    expect(assigned.status).toBe(200);
    const assignLogs = await rowsFor(BOARD_CHANGE_ROUTES.assign);
    expect(assignLogs).toHaveLength(1);
    expect(assignLogs[0]).toMatchObject({ managerId: ownerId, managerName: ownerName, date });
    expect(assignLogs[0]?.summary).toBe(`2031-04-08 hour=10 station=${stationA} count=1`);
    expect(assignLogs[0]?.summary).not.toContain(prose);

    const shifted = await assignShift(
      authed(ownerToken, "http://local/api/assignments/shift", {
        method: "PUT",
        body: JSON.stringify({ shiftId: shift.id, stationId: stationB, date, note: prose }),
      }),
    );
    expect(shifted.status).toBe(200);
    expect(await rowsFor(BOARD_CHANGE_ROUTES.shift)).toHaveLength(1);

    await prisma.assignment.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    const suggested = await suggest(
      authed(ownerToken, "http://local/api/assignments/suggest", {
        method: "PUT",
        body: JSON.stringify({ board: "caja", date, hour: 11, stationId: stationA, shiftId: shift.id, note: prose }),
      }),
    );
    expect(suggested.status, await suggested.text()).toBe(200);
    expect(await rowsFor(BOARD_CHANGE_ROUTES.suggest)).toHaveLength(1);

    await prisma.assignment.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    const painted = await paint(
      authed(ownerToken, "http://local/api/assignments/paint", {
        method: "PUT",
        body: JSON.stringify({
          board: "caja",
          date,
          edits: [
            {
              shiftId: shift.id,
              hour: 12,
              expectedShift: {
                startAt: startAt.toISOString(),
                endAt: endAt.toISOString(),
                employeeId,
                sourcePosition: stamp,
              },
              expected: null,
              stationId: stationA,
              note: prose,
            },
          ],
        }),
      }),
    );
    expect(painted.status, await painted.clone().text()).toBe(200);
    const paintLogs = await rowsFor(BOARD_CHANGE_ROUTES.paint);
    expect(paintLogs).toHaveLength(1);
    expect(paintLogs[0]?.summary).not.toContain(prose);
    expect(paintLogs[0]?.managerName).toBe(ownerName);

    await prisma.assignment.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    const occupied = await prisma.assignment.create({
      data: {
        shiftId: otherShift.id,
        employeeId: otherId,
        stationId: stationB,
        hourStart: chicagoHourStart(date, 13),
        hourEnd: chicagoHourEnd(date, 13),
      },
    });
    const paintCount = await prisma.boardChangeLog.count({ where: { route: BOARD_CHANGE_ROUTES.paint, managerId: ownerId } });
    const full = await paint(
      authed(ownerToken, "http://local/api/assignments/paint", {
        method: "PUT",
        body: JSON.stringify({
          board: "caja",
          date,
          edits: [
            {
              shiftId: shift.id,
              hour: 13,
              expectedShift: {
                startAt: startAt.toISOString(),
                endAt: endAt.toISOString(),
                employeeId,
                sourcePosition: stamp,
              },
              expected: null,
              stationId: stationB,
            },
          ],
        }),
      }),
    );
    expect(full.status).toBe(422);
    expect(await prisma.boardChangeLog.count({ where: { route: BOARD_CHANGE_ROUTES.paint, managerId: ownerId } })).toBe(paintCount);
    await prisma.assignment.delete({ where: { id: occupied.id } });

    const fixed = await placeFixed(
      authed(ownerToken, "http://local/api/assignments/fixed", {
        method: "PUT",
        body: JSON.stringify({ board: "caja", date, note: prose }),
      }),
    );
    expect(fixed.status).toBe(200);
    expect(await rowsFor(BOARD_CHANGE_ROUTES.fixed)).toHaveLength(1);

    await prisma.assignment.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    const left = await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId,
        stationId: stationA,
        hourStart: chicagoHourStart(date, 10),
        hourEnd: chicagoHourEnd(date, 10),
      },
    });
    const right = await prisma.assignment.create({
      data: {
        shiftId: otherShift.id,
        employeeId: otherId,
        stationId: stationB,
        hourStart: left.hourStart,
        hourEnd: left.hourEnd,
      },
    });
    const swapped = await swap(
      authed(ownerToken, "http://local/api/assignments/swap", {
        method: "POST",
        body: JSON.stringify({ assignmentIdA: left.id, assignmentIdB: right.id, note: prose }),
      }),
    );
    expect(swapped.status, await swapped.clone().text()).toBe(200);
    const swapLogs = await rowsFor(BOARD_CHANGE_ROUTES.swap);
    expect(swapLogs).toHaveLength(1);
    expect(swapLogs[0]?.summary).toContain("count=2");
    expect(swapLogs[0]?.summary).not.toContain(prose);

    const source = await prisma.assignment.findFirst({
      where: { shiftId: shift.id, hourStart: chicagoHourStart(date, 14) },
    });
    const sourceRow = source ?? await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId,
        stationId: stationA,
        hourStart: chicagoHourStart(date, 14),
        hourEnd: chicagoHourEnd(date, 14),
      },
    });
    const copied = await copyDay(
      authed(ownerToken, "http://local/api/assignments/copy-day", {
        method: "POST",
        body: JSON.stringify({ board: "caja", sourceDate: date, targetDate: nextDate, note: prose }),
      }),
    );
    expect(copied.status, await copied.clone().text()).toBe(200);
    expect(await rowsFor(BOARD_CHANGE_ROUTES.copyDay)).toHaveLength(1);
    expect(targetShift.id).toBeTruthy();
    expect(sourceRow.id).toBeTruthy();

    const doomed = await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId,
        stationId: stationB,
        hourStart: chicagoHourStart(date, 15),
        hourEnd: chicagoHourEnd(date, 15),
      },
    });
    const cleared = await clearHour(
      authed(ownerToken, `http://local/api/assignments/${doomed.id}`, {
        method: "DELETE",
        body: JSON.stringify({ note: prose }),
      }),
      { params: Promise.resolve({ id: doomed.id }) },
    );
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const clearLogs = await rowsFor(BOARD_CHANGE_ROUTES.clear);
    expect(clearLogs).toHaveLength(1);
    expect(clearLogs[0]?.summary).not.toContain(prose);

    const moved = await logMove(
      authed(ownerToken, "http://local/api/position-moves", {
        method: "POST",
        body: JSON.stringify({
          date,
          hour: 10,
          employeeId,
          fromStationId: stationA,
          toStationId: stationB,
          reason: "Break",
          note: prose,
        }),
      }),
    );
    expect(moved.status).toBe(200);
    const moveLogs = await rowsFor(BOARD_CHANGE_ROUTES.positionMove);
    expect(moveLogs).toHaveLength(1);
    expect(moveLogs[0]?.managerName).toBe(ownerName);
    expect(moveLogs[0]?.summary).not.toContain(prose);
    expect(moveLogs[0]?.summary).not.toContain("Break");

    const badMove = await logMove(
      authed(ownerToken, "http://local/api/position-moves", {
        method: "POST",
        body: JSON.stringify({ date, hour: 10, employeeId, reason: prose }),
      }),
    );
    expect(badMove.status).toBe(422);
    expect(await rowsFor(BOARD_CHANGE_ROUTES.positionMove)).toHaveLength(1);

    const managerWrite = await assignHour(
      authed(managerToken, "http://local/api/assignments", {
        method: "PUT",
        body: JSON.stringify({ shiftId: shift.id, stationId: stationB, date, hour: 16 }),
      }),
    );
    expect(managerWrite.status).toBe(403); // Ordinary managers cannot write this future date.
    const managerLogs = await prisma.boardChangeLog.findMany({ where: { managerId: manager.id } });
    expect(managerLogs).toHaveLength(0);
  }, 60_000);

  it("A11 a thrown log write rolls back shift, suggest, fixed, and copy-day", async () => {
    expect(primaryShiftId).not.toBe("");
    await prisma.assignment.deleteMany({ where: { employeeId: { in: [employeeId, otherId] } } });
    const beforeLogs = await prisma.boardChangeLog.count({ where: { managerId: ownerId } });
    const spy = vi.spyOn(boardChangeLog, "writeBoardChange").mockRejectedValue(new Error("log failed"));
    try {
      const placed = async () => prisma.assignment.count({ where: { employeeId } });

      const shifted = await assignShift(
        authed(ownerToken, "http://local/api/assignments/shift", {
          method: "PUT",
          body: JSON.stringify({ shiftId: primaryShiftId, stationId: stationB, date }),
        }),
      );
      expect(shifted.status).toBe(400);
      expect(await shifted.json()).toMatchObject({ error: "log failed" });
      expect(await placed()).toBe(0);

      const suggested = await suggest(
        authed(ownerToken, "http://local/api/assignments/suggest", {
          method: "PUT",
          body: JSON.stringify({
            board: "caja",
            date,
            hour: 11,
            stationId: stationA,
            shiftId: primaryShiftId,
          }),
        }),
      );
      expect(suggested.status).toBe(400);
      expect(await suggested.json()).toMatchObject({ error: "log failed" });
      expect(await placed()).toBe(0);

      const fixed = await placeFixed(
        authed(ownerToken, "http://local/api/assignments/fixed", {
          method: "PUT",
          body: JSON.stringify({ board: "caja", date }),
        }),
      );
      expect(fixed.status).toBe(400);
      expect(await fixed.json()).toMatchObject({ error: "log failed" });
      expect(await placed()).toBe(0);

      await prisma.assignment.create({
        data: {
          shiftId: primaryShiftId,
          employeeId,
          stationId: stationA,
          hourStart: chicagoHourStart(date, 14),
          hourEnd: chicagoHourEnd(date, 14),
        },
      });
      const copied = await copyDay(
        authed(ownerToken, "http://local/api/assignments/copy-day", {
          method: "POST",
          body: JSON.stringify({ board: "caja", sourceDate: date, targetDate: nextDate }),
        }),
      );
      expect(copied.status).toBe(400);
      expect(await copied.json()).toMatchObject({ error: "log failed" });
      expect(await prisma.assignment.count({ where: { shiftId: targetShiftId } })).toBe(0);
      expect(await prisma.assignment.count({ where: { shiftId: primaryShiftId } })).toBe(1);

      expect(await prisma.boardChangeLog.count({ where: { managerId: ownerId } })).toBe(beforeLogs);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("A12 owner change log lists a removal and a paint by name; manager is 403", async () => {
    const removal = await prisma.shiftRemoval.create({
      data: {
        externalId: stamp,
        date,
        board: "caja",
        sourcePosition: stamp,
        startAt: chicagoDateTime(date, "9:00 am"),
        endAt: chicagoDateTime(date, "10:00 am"),
        events: {
          create: {
            action: "remove",
            revision: 1,
            managerId: ownerId,
            managerName: ownerName,
            reason: "audit",
            sourceJson: "{}",
            cellsJson: "[]",
          },
        },
      },
      include: { events: true },
    });
    expect(removal.events[0]?.managerName).toBe(ownerName);

    const noToken = await listChanges(new Request("http://local/api/admin/changes"));
    expect(noToken.status).toBe(401);
    const asManager = await listChanges(authed(managerToken, "http://local/api/admin/changes"));
    expect(asManager.status).toBe(403);
    const asOwner = await listChanges(authed(ownerToken, `http://local/api/admin/changes?date=${date}`));
    expect(asOwner.status).toBe(200);
    const body = (await asOwner.json()) as {
      changes: Array<{ who: string; what: string; kind: string; createdAt: string }>;
    };
    const paintRow = body.changes.find((row) => row.kind === "change" && row.what.includes("hour=12"));
    const removalRow = body.changes.find((row) => row.kind === "removal");
    expect(paintRow?.who).toBe(ownerName);
    expect(removalRow?.who).toBe(ownerName);
    expect(removalRow?.what).toContain("remove");
    const stamps = body.changes.map((row) => row.createdAt);
    expect(stamps).toEqual([...stamps].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
    expect(body.changes.length).toBeGreaterThan(1);
  });
});
