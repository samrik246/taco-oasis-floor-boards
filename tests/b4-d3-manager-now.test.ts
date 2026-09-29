/**
 * B4 D3: manager break moves and the read-only on-break page.
 * Rich's letters are 1A 2A 3A 4A. Elliot's 23:57:55 reply governs the folds.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { GET as boardDay } from "@/app/api/boards/[board]/days/[date]/route";
import { DELETE as deleteManage, GET as getManage, POST as postManage } from "@/app/api/breaks/manage/route";
import { GET as getMine } from "@/app/api/breaks/mine/route";
import { GET as getNow } from "@/app/api/breaks/now/route";
import { boardChangeSummary, BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { MANAGER_BREAK_TEXT } from "@/lib/breaks/messages";
import { loadManagedBreak, saveManagedBreak } from "@/lib/breaks/manage";
import { listBreaksNow } from "@/lib/breaks/now";
import { managerShiftLine, showDescansoButton } from "@/lib/breaks/picker-steps";
import {
  assessBreak,
  BreakRefused,
  calendarWeekday,
  clearBreak,
  saveBreak,
  type BreakShift,
} from "@/lib/breaks/rules";
import { signStaffSession } from "@/lib/breaks/session";
import { TIMEZONE } from "@/lib/constants";
import { chicagoDateOffset } from "@/lib/date-math";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const stamp = `b4d3-${Date.now()}`;
const TEST_SECRET = "b4-d3-test-manager-session-secret-00";
const priorSecret = process.env.MANAGER_SESSION_SECRET;
const priorNow = process.env.FLOOR_BOARDS_E2E_NOW;

function ymdForWeekday(weekday: number): string {
  let date = "2036-06-01";
  for (let step = 0; step < 7; step += 1) {
    if (calendarWeekday(date) === weekday) return date;
    date = chicagoDateOffset(date, 1);
  }
  throw new Error("no calendar date");
}

const wednesday = ymdForWeekday(3);
const saturday = ymdForWeekday(6);
const clock = (iso: string) => formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");

function pin(date: string, time: string) {
  if (!process.env.FLOOR_BOARDS_TEST_ROOT) {
    throw new Error("FLOOR_BOARDS_TEST_ROOT is required for the pinned break clock");
  }
  process.env.FLOOR_BOARDS_E2E_NOW = chicagoDateTime(date, time).toISOString();
}

function unpin() {
  if (priorNow === undefined) delete process.env.FLOOR_BOARDS_E2E_NOW;
  else process.env.FLOOR_BOARDS_E2E_NOW = priorNow;
}

async function person(suffix: string, firstName: string, lastName = "Leakname") {
  return prisma.employee.create({
    data: { externalId: `${stamp}-${suffix}`, firstName, lastName },
  });
}

async function shiftFor(
  employeeId: string,
  date: string,
  board: string,
  start: string,
  end: string,
  extra: { supersededAt?: Date; boardRemoved?: boolean } = {},
) {
  return prisma.shift.create({
    data: {
      employeeId,
      date,
      board,
      sourcePosition: "Cocina",
      startAt: chicagoDateTime(date, start),
      endAt: chicagoDateTime(date, end),
      ...extra,
    },
  });
}

async function manager() {
  const row = await prisma.manager.create({
    data: { name: `${stamp} Ana`, codeHash: hashManagerCode("1357"), active: true },
  });
  return {
    row,
    actor: { id: row.id, name: row.name, kind: "manager" as const },
    token: signManagerSession({ id: row.id, name: row.name }),
  };
}

function manageRequest(method: string, token: string | null, body?: unknown, query = "") {
  return new Request(`http://local/api/breaks/manage${query}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-manager-session": token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function acceptedSlots(
  date: string,
  board: "caja" | "cocina",
  shifts: readonly BreakShift[],
  otherBreaks: readonly { board: string; startAt: Date; endAt: Date }[],
) {
  const found: { startAt: string; endAt: string }[] = [];
  const start = chicagoDateTime(date, "12:00 am").getTime();
  const end = chicagoDateTime(chicagoDateOffset(date, 1), "12:00 am").getTime();
  for (let at = start; at < end; at += 15 * 60_000) {
    for (let minutes = 15; minutes <= 90; minutes += 15) {
      const startAt = new Date(at);
      const endAt = new Date(at + minutes * 60_000);
      const decision = assessBreak({ date, startAt, endAt, shifts, otherBreaks });
      if ("code" in decision || decision.board !== board) continue;
      found.push({ startAt: startAt.toISOString(), endAt: endAt.toISOString() });
    }
  }
  return found;
}

describe("B4 D3 manager breaks and the now page", () => {
  beforeEach(() => {
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    unpin();
  });

  afterAll(async () => {
    unpin();
    if (priorSecret === undefined) delete process.env.MANAGER_SESSION_SECRET;
    else process.env.MANAGER_SESSION_SECRET = priorSecret;
    const people = await prisma.employee.findMany({
      where: { externalId: { startsWith: stamp } },
      select: { id: true },
    });
    const ids = people.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.staffBreak.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    const managers = await prisma.manager.findMany({
      where: { name: { startsWith: stamp } },
      select: { id: true },
    });
    const managerIds = managers.map((row) => row.id);
    const logIds = [...ids, ...managerIds];
    if (logIds.length > 0) {
      await prisma.boardChangeLog.deleteMany({ where: { managerId: { in: logIds } } });
    }
    await prisma.staffBreak.deleteMany({ where: { employeeId: `${stamp}-missing` } });
    if (managerIds.length > 0) {
      await prisma.mandatoryMark.deleteMany({ where: { managerId: { in: managerIds } } });
      await prisma.manager.deleteMany({ where: { id: { in: managerIds } } });
    }
    await prisma.$disconnect();
  });

  it("puts the Descanso button on the first live row today, and names the shift in the manager's words", () => {
    expect(showDescansoButton({
      readonly: false,
      openDate: wednesday,
      today: wednesday,
      superseded: false,
      laterShiftOfPerson: false,
    })).toBe(true);
    expect(showDescansoButton({
      readonly: false,
      openDate: wednesday,
      today: wednesday,
      superseded: false,
      laterShiftOfPerson: true,
    })).toBe(false);
    expect(showDescansoButton({
      readonly: true,
      openDate: wednesday,
      today: wednesday,
      superseded: false,
      laterShiftOfPerson: false,
    })).toBe(false);
    expect(showDescansoButton({
      readonly: false,
      openDate: saturday,
      today: wednesday,
      superseded: false,
      laterShiftOfPerson: false,
    })).toBe(false);
    expect(showDescansoButton({
      readonly: false,
      openDate: wednesday,
      today: wednesday,
      superseded: true,
      laterShiftOfPerson: false,
    })).toBe(false);
    const start = chicagoDateTime(wednesday, "8:00 am").toISOString();
    const end = chicagoDateTime(wednesday, "4:00 pm").toISOString();
    expect(managerShiftLine("Ada", [{ startAt: start, endAt: end }], 60, clock)).toBe(
      "Ada. 08:00 a 16:00. Le tocan 60 minutos.",
    );
  });

  it("puts the employee id on both manager log branches and leaves staff summaries alone", () => {
    expect(boardChangeSummary({
      date: wednesday,
      count: 1,
      breakStart: "09:00",
      breakEnd: "09:15",
      employeeId: "abc123",
    })).toBe(`${wednesday} start=09:00 end=09:15 employee=abc123`);
    expect(boardChangeSummary({
      date: wednesday,
      count: 1,
      board: "cocina",
      employeeId: "abc123",
    })).toBe(`${wednesday} board=cocina employee=abc123 count=1`);
    expect(boardChangeSummary({
      date: wednesday,
      count: 1,
      breakStart: "09:00",
      breakEnd: "09:15",
    })).toBe(`${wednesday} start=09:00 end=09:15`);
    expect(boardChangeSummary({
      date: wednesday,
      count: 1,
      board: "caja",
    })).toBe(`${wednesday} board=caja count=1`);
  });

  it("refuses manage without a session or with a staff token, and the staff route refuses a manager token", async () => {
    const ada = await person("ada", "Ada");
    const boss = await manager();
    const staff = signStaffSession({ employeeId: ada.id, board: "cocina" });
    for (const call of [
      () => getManage(manageRequest("GET", null, undefined, `?board=cocina&employeeId=${ada.id}`)),
      () => postManage(manageRequest("POST", null, { board: "cocina", employeeId: ada.id, startAt: "x", endAt: "y" })),
      () => deleteManage(manageRequest("DELETE", null, { board: "cocina", employeeId: ada.id })),
      () => getManage(manageRequest("GET", staff, undefined, `?board=cocina&employeeId=${ada.id}`)),
      () => postManage(new Request("http://local/api/breaks/manage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-staff-session": staff, "x-manager-session": staff },
        body: JSON.stringify({ board: "cocina", employeeId: ada.id, startAt: "x", endAt: "y" }),
      })),
      () => deleteManage(manageRequest("DELETE", staff, { board: "cocina", employeeId: ada.id })),
    ]) {
      expect((await call()).status).toBe(401);
    }
    const mine = await getMine(new Request("http://local/api/breaks/mine", {
      headers: { "x-staff-session": boss.token },
    }));
    expect(mine.status).toBe(401);
    const headerMine = await getMine(new Request("http://local/api/breaks/mine", {
      headers: { "x-manager-session": boss.token },
    }));
    expect(headerMine.status).toBe(401);

    delete process.env.MANAGER_SESSION_SECRET;
    expect((await getManage(manageRequest("GET", boss.token, undefined, `?board=cocina&employeeId=${ada.id}`))).status).toBe(503);
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;

    pin(wednesday, "10:00 am");
    await shiftFor(ada.id, wednesday, "cocina", "8:00 am", "4:00 pm");
    const opened = await getManage(manageRequest("GET", boss.token, undefined, `?board=cocina&employeeId=${ada.id}`));
    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe("private, no-store");
    const openedBody = await opened.json() as { row: string };
    expect(openedBody.row).toBe("absent");
    expect(JSON.stringify(openedBody)).not.toContain(ada.externalId);
    expect(JSON.stringify(openedBody)).not.toContain("Leakname");

    const missing = await getManage(manageRequest("GET", boss.token, undefined, "?board=cocina&employeeId=missing-person"));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe(MANAGER_BREAK_TEXT.NOT_FOUND);
    expect((await getNow(new Request("http://local/api/breaks/now"))).status).toBe(400);
    expect((await getNow(new Request("http://local/api/breaks/now?board=wall"))).status).toBe(400);
  });

  it("offers the same slots assessBreak accepts, including a split day and each allowance", async () => {
    const boss = await manager();
    const cases: { date: string; board: "caja" | "cocina"; windows: [string, string, string][]; allowance: number }[] = [
      { date: wednesday, board: "cocina", windows: [["cocina", "8:00 am", "1:00 pm"]], allowance: 15 },
      { date: wednesday, board: "cocina", windows: [["cocina", "8:00 am", "2:00 pm"]], allowance: 30 },
      { date: wednesday, board: "cocina", windows: [["cocina", "8:00 am", "4:00 pm"]], allowance: 60 },
      { date: saturday, board: "cocina", windows: [["cocina", "7:00 am", "6:00 pm"]], allowance: 90 },
      { date: wednesday, board: "cocina", windows: [["cocina", "8:00 am", "12:00 pm"], ["caja", "12:00 pm", "4:00 pm"]], allowance: 60 },
    ];
    for (const [index, item] of cases.entries()) {
      const worker = await person(`tier-${index}`, "Nia");
      const shifts = [];
      for (const [board, start, end] of item.windows) {
        shifts.push(await shiftFor(worker.id, item.date, board, start, end));
      }
      const loaded = await loadManagedBreak({
        board: item.board,
        employeeId: worker.id,
        now: chicagoDateTime(item.date, "10:00 am"),
      });
      expect(loaded.allowanceMinutes).toBe(item.allowance);
      expect(loaded.shifts).toHaveLength(item.windows.filter((window) => window[0] === item.board).length);
      const expected = acceptedSlots(item.date, item.board, shifts, []);
      const key = (row: { startAt: string; endAt: string }) => `${row.startAt}|${row.endAt}`;
      expect(loaded.slots.map(key).sort()).toEqual(expected.map(key).sort());
      expect(loaded.row).toBe("absent");
      expect(JSON.stringify(loaded)).not.toContain(worker.externalId);
    }

    const ada = await person("rules", "Ada");
    const bea = await person("other", "Bea");
    await shiftFor(ada.id, wednesday, "cocina", "8:00 am", "4:00 pm");
    await shiftFor(ada.id, wednesday, "caja", "5:00 pm", "9:00 pm");
    const beaShift = await shiftFor(bea.id, wednesday, "cocina", "8:00 am", "4:00 pm");
    const now = chicagoDateTime(wednesday, "10:00 am");
    await saveBreak({
      employeeId: bea.id,
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "9:00 am"),
      endAt: chicagoDateTime(wednesday, "9:15 am"),
      expectedBoard: "cocina",
    });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(0);

    pin(wednesday, "10:00 am");
    const blackout = await postManage(manageRequest("POST", boss.token, {
      board: "cocina",
      employeeId: ada.id,
      startAt: chicagoDateTime(wednesday, "11:00 am").toISOString(),
      endAt: chicagoDateTime(wednesday, "11:15 am").toISOString(),
    }));
    expect(blackout.status).toBe(400);
    expect((await blackout.json()).error).toBe(MANAGER_BREAK_TEXT.BLACKOUT);

    const refusedBlackout = await saveManagedBreak({
      manager: boss.actor,
      board: "cocina",
      employeeId: ada.id,
      startAt: chicagoDateTime(wednesday, "11:00 am"),
      endAt: chicagoDateTime(wednesday, "11:15 am"),
      now,
    }).then(() => null, (error: unknown) => error);
    expect(refusedBlackout).toMatchObject({ code: "BLACKOUT" });
    const refusedAllowance = await saveManagedBreak({
      manager: boss.actor,
      board: "cocina",
      employeeId: ada.id,
      startAt: chicagoDateTime(wednesday, "2:00 pm"),
      endAt: chicagoDateTime(wednesday, "3:45 pm"),
      now,
    }).then(() => null, (error: unknown) => error);
    expect(refusedAllowance).toMatchObject({ code: "ALLOWANCE" });
    const refusedOverlap = await saveManagedBreak({
      manager: boss.actor,
      board: "cocina",
      employeeId: ada.id,
      startAt: chicagoDateTime(wednesday, "9:00 am"),
      endAt: chicagoDateTime(wednesday, "9:15 am"),
      now,
    }).then(() => null, (error: unknown) => error);
    expect(refusedOverlap).toMatchObject({ code: "OVERLAP" });
    const refusedBoard = await saveManagedBreak({
      manager: boss.actor,
      board: "cocina",
      employeeId: ada.id,
      startAt: chicagoDateTime(wednesday, "5:00 pm"),
      endAt: chicagoDateTime(wednesday, "5:15 pm"),
      now,
    }).then(() => null, (error: unknown) => error);
    expect(refusedBoard).toMatchObject({ code: "BOARD_MISMATCH" });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(0);
    expect((await prisma.staffBreak.findUnique({ where: { employeeId_date: { employeeId: bea.id, date: wednesday } } }))?.shiftId).toBe(beaShift.id);

    const created = await saveManagedBreak({
      manager: boss.actor,
      board: "cocina",
      employeeId: ada.id,
      startAt: chicagoDateTime(wednesday, "9:15 am"),
      endAt: chicagoDateTime(wednesday, "9:30 am"),
      now,
    });
    expect(created.replaced).toBe(false);
    const row = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: ada.id, date: wednesday } },
    });
    expect(row.actor).toBe(boss.row.id);
    const saveLog = await prisma.boardChangeLog.findFirstOrThrow({
      where: { route: BOARD_CHANGE_ROUTES.breakManagerSave, managerId: boss.row.id, date: wednesday },
      orderBy: { createdAt: "desc" },
    });
    expect(saveLog.managerName).toBe(boss.row.name);
    expect(saveLog.summary).toBe(`${wednesday} start=09:15 end=09:30 employee=${ada.id}`);
    expect(saveLog.summary).not.toContain("Leakname");
    expect(saveLog.summary).not.toContain(ada.externalId);
  });

  it("clears only a live row on this board, and logs the manager", async () => {
    const boss = await manager();
    const ada = await person("clear", "Ada");
    const now = chicagoDateTime(wednesday, "10:00 am");
    await shiftFor(ada.id, wednesday, "cocina", "8:00 am", "4:00 pm");
    await saveManagedBreak({
      manager: boss.actor,
      board: "cocina",
      employeeId: ada.id,
      startAt: chicagoDateTime(wednesday, "3:00 pm"),
      endAt: chicagoDateTime(wednesday, "3:15 pm"),
      now,
    });
    const other = await clearBreak({
      employeeId: ada.id,
      date: wednesday,
      board: "caja",
      actor: boss.actor,
    }).then(() => null, (error: unknown) => error);
    expect(other).toMatchObject({ code: "BOARD_MISMATCH" });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(1);

    await prisma.shift.updateMany({
      where: { employeeId: ada.id, date: wednesday, board: "cocina" },
      data: { supersededAt: chicagoDateTime(wednesday, "9:00 am") },
    });
    const dead = await clearBreak({
      employeeId: ada.id,
      date: wednesday,
      board: "cocina",
      actor: boss.actor,
    }).then(() => null, (error: unknown) => error);
    expect(dead).toMatchObject({ code: "OUTSIDE_SHIFT" });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(1);

    await prisma.shift.updateMany({
      where: { employeeId: ada.id, date: wednesday },
      data: { supersededAt: null },
    });
    const lockBefore = await prisma.staffBreakLock.findUnique({ where: { id: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cleared = await clearBreak({
      employeeId: ada.id,
      date: wednesday,
      board: "cocina",
      actor: boss.actor,
    });
    expect(cleared.cleared).toBe(true);
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(0);
    const lockAfter = await prisma.staffBreakLock.findUniqueOrThrow({ where: { id: 1 } });
    expect(lockAfter.updatedAt.getTime()).toBeGreaterThan(lockBefore?.updatedAt.getTime() ?? 0);
    const clearLog = await prisma.boardChangeLog.findFirstOrThrow({
      where: { route: BOARD_CHANGE_ROUTES.breakManagerClear, managerId: boss.row.id, date: wednesday },
      orderBy: { createdAt: "desc" },
    });
    expect(clearLog.summary).toBe(`${wednesday} board=cocina employee=${ada.id} count=1`);

    const empty = await clearBreak({
      employeeId: ada.id,
      date: wednesday,
      board: "cocina",
      actor: boss.actor,
    });
    expect(empty.cleared).toBe(false);

    await saveBreak({
      employeeId: ada.id,
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "2:00 pm"),
      endAt: chicagoDateTime(wednesday, "2:15 pm"),
    });
    const staffLog = await prisma.boardChangeLog.findFirstOrThrow({
      where: { route: BOARD_CHANGE_ROUTES.breakSave, managerId: ada.id, date: wednesday },
      orderBy: { createdAt: "desc" },
    });
    expect(staffLog.summary).toBe(`${wednesday} start=14:00 end=14:15`);
    const staffClear = await clearBreak({ employeeId: ada.id, date: wednesday, board: "cocina" });
    expect(staffClear.cleared).toBe(true);
    const staffClearLog = await prisma.boardChangeLog.findFirstOrThrow({
      where: { route: BOARD_CHANGE_ROUTES.breakClear, managerId: ada.id, date: wednesday },
      orderBy: { createdAt: "desc" },
    });
    expect(staffClearLog.summary).toBe(`${wednesday} board=cocina count=1`);
    expect(staffClearLog.summary).not.toContain("employee=");
  });

  it("leaves one row when two saves overlap, and does not change paint", async () => {
    const boss = await manager();
    const ada = await person("race-a", "Ada");
    const bea = await person("race-b", "Bea");
    const raceDate = chicagoDateOffset(wednesday, 35);
    const adaShift = await shiftFor(ada.id, raceDate, "cocina", "8:00 am", "4:00 pm");
    await shiftFor(bea.id, raceDate, "cocina", "8:00 am", "4:00 pm");
    const station = await prisma.station.findFirstOrThrow({ where: { board: "cocina" } });
    await prisma.assignment.create({
      data: {
        shiftId: adaShift.id,
        employeeId: ada.id,
        stationId: station.id,
        hourStart: chicagoDateTime(raceDate, "9:00 am"),
        hourEnd: chicagoDateTime(raceDate, "10:00 am"),
      },
    });
    await prisma.mandatoryMark.create({
      data: { board: "cocina", date: raceDate, stationId: station.id, managerId: boss.row.id },
    });
    const paintBefore = JSON.stringify(await prisma.assignment.findMany({ where: { employeeId: ada.id } }));
    const marksBefore = JSON.stringify(await prisma.mandatoryMark.findMany({ where: { date: raceDate, managerId: boss.row.id } }));
    const dayBefore = await boardDay(new Request(`http://local/api/boards/cocina/days/${raceDate}`, {
      headers: { "x-manager-session": boss.token },
    }), { params: Promise.resolve({ board: "cocina", date: raceDate }) });
    const beforeBody = await dayBefore.json() as { shifts: { id: string; assignments: unknown[] }[]; mandatory: unknown };

    const slot = {
      date: raceDate,
      startAt: chicagoDateTime(raceDate, "9:00 am"),
      endAt: chicagoDateTime(raceDate, "9:15 am"),
      expectedBoard: "cocina" as const,
    };
    const raced = await Promise.allSettled([
      saveBreak({ employeeId: ada.id, ...slot }),
      saveBreak({ employeeId: bea.id, ...slot }),
    ]);
    const won = raced.filter((result) => result.status === "fulfilled");
    const lost = raced.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toBeInstanceOf(BreakRefused);
    expect(lost[0]?.reason).toMatchObject({ code: "OVERLAP" });
    expect(await prisma.staffBreak.count({ where: { employeeId: { in: [ada.id, bea.id] }, date: raceDate } })).toBe(1);

    const replaced = await Promise.allSettled([
      saveManagedBreak({
        manager: boss.actor,
        board: "cocina",
        employeeId: ada.id,
        startAt: chicagoDateTime(raceDate, "2:00 pm"),
        endAt: chicagoDateTime(raceDate, "2:15 pm"),
        now: chicagoDateTime(raceDate, "10:00 am"),
      }),
      saveBreak({
        employeeId: ada.id,
        date: raceDate,
        startAt: chicagoDateTime(raceDate, "3:00 pm"),
        endAt: chicagoDateTime(raceDate, "3:15 pm"),
        expectedBoard: "cocina",
      }),
    ]);
    expect(replaced.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id, date: raceDate } })).toBe(1);

    expect(JSON.stringify(await prisma.assignment.findMany({ where: { employeeId: ada.id } }))).toBe(paintBefore);
    expect(JSON.stringify(await prisma.mandatoryMark.findMany({ where: { date: raceDate, managerId: boss.row.id } }))).toBe(marksBefore);
    const day = await boardDay(new Request(`http://local/api/boards/cocina/days/${raceDate}`, {
      headers: { "x-manager-session": boss.token },
    }), { params: Promise.resolve({ board: "cocina", date: raceDate }) });
    const body = await day.json() as { shifts: { id: string; assignments: unknown[] }[]; mandatory: unknown; breaks?: unknown[] };
    const slice = (shifts: { id: string; assignments: unknown[] }[]) =>
      JSON.stringify(shifts.map((shift) => ({ id: shift.id, assignments: shift.assignments })));
    expect(slice(body.shifts)).toBe(slice(beforeBody.shifts));
    expect(JSON.stringify(body.mandatory)).toBe(JSON.stringify(beforeBody.mandatory));
    expect((body.breaks ?? []).length).toBeGreaterThan(0);
  });

  it("splits now and the next three, and hides ids", async () => {
    const asOf = chicagoDateTime(wednesday, "10:00 am");
    const ada = await person("now", "Ada");
    const names = ["Bea", "Cia", "Dia", "Eva", "Fia"];
    const live = await shiftFor(ada.id, wednesday, "cocina", "8:00 am", "4:00 pm");
    await prisma.staffBreak.create({
      data: {
        employeeId: ada.id,
        shiftId: live.id,
        board: "cocina",
        date: wednesday,
        startAt: new Date(asOf.getTime() - 5 * 60_000),
        endAt: new Date(asOf.getTime() + 20 * 60_000),
        actor: ada.id,
      },
    });
    const endedShift = await shiftFor((await person("ended", "Gus")).id, wednesday, "cocina", "8:00 am", "4:00 pm");
    await prisma.staffBreak.create({
      data: {
        employeeId: endedShift.employeeId,
        shiftId: endedShift.id,
        board: "cocina",
        date: wednesday,
        startAt: new Date(asOf.getTime() - 30 * 60_000),
        endAt: new Date(asOf.getTime() - 60_000),
        actor: endedShift.employeeId,
      },
    });
    const deadPerson = await person("dead", "Hal");
    const deadShift = await shiftFor(deadPerson.id, wednesday, "cocina", "8:00 am", "4:00 pm", {
      supersededAt: asOf,
    });
    await prisma.staffBreak.create({
      data: {
        employeeId: deadPerson.id,
        shiftId: deadShift.id,
        board: "cocina",
        date: wednesday,
        startAt: new Date(asOf.getTime() - 5 * 60_000),
        endAt: new Date(asOf.getTime() + 5 * 60_000),
        actor: deadPerson.id,
      },
    });
    await prisma.staffBreak.create({
      data: {
        employeeId: `${stamp}-missing`,
        shiftId: live.id,
        board: "cocina",
        date: wednesday,
        startAt: new Date(asOf.getTime() + 10 * 60_000),
        endAt: new Date(asOf.getTime() + 25 * 60_000),
        actor: "missing",
      },
    });
    const futureIds: string[] = [];
    for (const [index, name] of names.entries()) {
      const worker = await person(`next-${index}`, name);
      futureIds.push(worker.id);
      const shift = await shiftFor(worker.id, wednesday, "cocina", "8:00 am", "4:00 pm");
      await prisma.staffBreak.create({
        data: {
          employeeId: worker.id,
          shiftId: shift.id,
          board: "cocina",
          date: wednesday,
          startAt: new Date(asOf.getTime() + (index + 1) * 30 * 60_000),
          endAt: new Date(asOf.getTime() + (index + 1) * 30 * 60_000 + 15 * 60_000),
          actor: worker.id,
        },
      });
    }
    const listed = await listBreaksNow("cocina", asOf);
    expect(listed.asOf).toBe(asOf.toISOString());
    expect(listed.now.map((row) => row.firstName)).toEqual(["Ada"]);
    expect(listed.next.map((row) => row.firstName)).toEqual(["Bea", "Cia", "Dia"]);
    const packed = JSON.stringify(listed);
    expect(packed).not.toContain("Leakname");
    expect(packed).not.toContain(ada.externalId);
    expect(packed).not.toContain(ada.id);
    expect(packed).not.toContain("CODE9182");
    for (const id of futureIds) expect(packed).not.toContain(id);

    pin(wednesday, "10:00 am");
    const response = await getNow(new Request(`http://local/api/breaks/now?board=cocina&date=1999-01-01`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as { now: { firstName: string }[]; next: { firstName: string }[] };
    expect(body.now.map((row) => row.firstName)).toEqual(["Ada"]);
    expect(body.next).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain(ada.id);
  });
});
