import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET as listDays } from "@/app/api/days/route";
import { GET as boardDay } from "@/app/api/boards/[board]/days/[date]/route";
import { GET as listTareas, POST as assignTarea } from "@/app/api/tareas/route";
import { GET as listReturnPrompts } from "@/app/api/return-prompts/route";
import { GET as listPositionMoves } from "@/app/api/position-moves/route";
import { GET as employeeHours } from "@/app/api/employees/[id]/hours/route";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { requireDayAccess } from "@/lib/managers/day-access";
import { forecastForScreen, offlineRefreshState, panelResponse } from "@/lib/board/refresh-state";
import { readLastBoard, readLastBoardFor, saveLastBoard } from "@/lib/offline-board";
import { chicagoToday } from "@/lib/upcoming/source";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const today = chicagoToday();
const planned = "2031-03-14";
const employeeId = "day-access-employee";
const todayShiftId = "day-access-today";
const plannedShiftId = "day-access-planned";

async function managerToken() {
  const codeHash = hashManagerCode("1357");
  const existing = await prisma.manager.findFirst({ where: { name: "Day Access Manager" } });
  const manager = existing
    ? await prisma.manager.update({ where: { id: existing.id }, data: { codeHash, active: true } })
    : await prisma.manager.create({ data: { name: "Day Access Manager", codeHash, active: true } });
  return signManagerSession({ id: manager.id, name: manager.name });
}

function request(url: string, token?: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (token) headers.set("x-manager-session", token);
  return new Request(`http://local${url}`, { ...init, headers });
}

function boardContext(date: string) {
  return { params: Promise.resolve({ board: "caja", date }) };
}

describe("staff see today only; a manager plans any day", () => {
  let token: string;

  beforeAll(async () => {
    token = await managerToken();
    await prisma.shift.deleteMany({ where: { id: { in: [todayShiftId, plannedShiftId] } } });
    await prisma.employee.deleteMany({ where: { id: employeeId } });
    await prisma.employee.create({
      data: { id: employeeId, externalId: employeeId, firstName: "Day", lastName: "Access" },
    });
    for (const [id, date] of [[todayShiftId, today], [plannedShiftId, planned]] as const) {
      await prisma.shift.create({
        data: {
          id,
          employeeId,
          date,
          board: "caja",
          sourcePosition: "Caja",
          startAt: chicagoDateTime(date, "9:00 am"),
          endAt: chicagoDateTime(date, "1:00 pm"),
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.shift.deleteMany({ where: { id: { in: [todayShiftId, plannedShiftId] } } });
    await prisma.employee.deleteMany({ where: { id: employeeId } });
    await prisma.$disconnect();
  });

  it("lists only today's date to staff and every date to a manager", async () => {
    const staff = await listDays(request("/api/days"));
    expect(staff.headers.get("cache-control")).toBe("private, no-store");
    const staffDates = (await staff.json()).dates as string[];
    expect(staffDates).toEqual([today]);

    const mgr = await (await listDays(request("/api/days", token))).json();
    expect(mgr.dates).toEqual(expect.arrayContaining([today, planned]));
  });

  it("treats an invalid manager token as staff for the day list", async () => {
    const res = await listDays(request("/api/days", "invalid"));
    expect((await res.json()).dates).toEqual([today]);
  });

  it("serves today's board to staff and refuses a direct planned-day URL", async () => {
    const todayRes = await boardDay(request(`/api/boards/caja/days/${today}`), boardContext(today));
    expect(todayRes.status).toBe(200);
    expect(todayRes.headers.get("cache-control")).toBe("private, no-store");
    const body = await todayRes.json();
    expect(body.shifts.map((s: { id: string }) => s.id)).toContain(todayShiftId);

    const plannedRes = await boardDay(request(`/api/boards/caja/days/${planned}`), boardContext(planned));
    expect(plannedRes.status).toBe(401);
    expect(JSON.stringify(await plannedRes.json())).not.toContain(plannedShiftId);
  });

  it("refuses yesterday's board to staff too", async () => {
    const yesterday = chicagoToday(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const res = await boardDay(request(`/api/boards/caja/days/${yesterday}`), boardContext(yesterday));
    expect(res.status).toBe(401);
  });

  it("serves a planned day to a manager", async () => {
    const res = await boardDay(request(`/api/boards/caja/days/${planned}`, token), boardContext(planned));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shifts.map((s: { id: string }) => s.id)).toContain(plannedShiftId);
  });

  const dayReads = [
    { name: "tareas", run: (date: string, t?: string) => listTareas(request(`/api/tareas?date=${date}&board=caja`, t)) },
    { name: "return prompts", run: (date: string, t?: string) => listReturnPrompts(request(`/api/return-prompts?date=${date}`, t)) },
    { name: "position moves", run: (date: string, t?: string) => listPositionMoves(request(`/api/position-moves?date=${date}`, t)) },
  ];

  for (const { name, run } of dayReads) {
    it(`opens today's ${name} to staff, planned days to a manager only`, async () => {
      const staffToday = await run(today);
      expect(staffToday.status).toBe(200);
      expect(staffToday.headers.get("cache-control")).toBe("private, no-store");
      expect((await run(planned)).status).toBe(401);
      expect((await run(planned, "invalid")).status).toBe(401);
      expect((await run(planned, token)).status).toBe(200);
    });
  }

  it("keeps the hours ledger manager-only (a week holds planned days)", async () => {
    const context = { params: Promise.resolve({ id: employeeId }) };
    const staff = await employeeHours(request(`/api/employees/${employeeId}/hours?weekOf=${today}`), context);
    expect(staff.status).toBe(401);
    const mgr = await employeeHours(request(`/api/employees/${employeeId}/hours?weekOf=${today}`, token), context);
    expect(mgr.status).toBe(200);
  });

  it("refuses a staff tarea assignment before reading the body", async () => {
    const res = await assignTarea(request("/api/tareas", undefined, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    }));
    expect(res.status).toBe(401);
  });

  it("moves staff to the new day at Chicago midnight", async () => {
    const staff = request("/api/boards/caja/days/2026-09-27");
    const beforeMidnight = new Date("2026-09-27T04:59:00Z"); // 23:59 Sep 26 Chicago
    const afterMidnight = new Date("2026-09-27T05:01:00Z"); // 00:01 Sep 27 Chicago
    expect((await requireDayAccess(staff, "2026-09-27", beforeMidnight)).ok).toBe(false);
    expect((await requireDayAccess(staff, "2026-09-27", afterMidnight)).ok).toBe(true);
    expect((await requireDayAccess(staff, "2026-09-26", afterMidnight)).ok).toBe(false);
  });
});

describe("offline cache keeps today only", () => {
  const store = new Map<string, string>();
  const now = new Date("2026-09-26T18:00:00Z"); // 1 PM Chicago, Sep 26
  const todayYmd = "2026-09-26";
  const board = (date: string) => ({ date, stations: [], shifts: [] });

  beforeAll(() => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
  });

  afterEach(() => store.clear());

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  function writeRaw(date: string) {
    store.set("taco-oasis-last-board-v1", JSON.stringify({
      version: 1, board: "caja", date, day: board(date), savedAt: now.toISOString(),
    }));
  }

  it("floor lock: a manager viewing a planned day never writes it to the cache", () => {
    saveLastBoard({ board: "caja", date: todayYmd, day: board(todayYmd) }, now);
    saveLastBoard({ board: "caja", date: "2026-10-02", day: board("2026-10-02") }, now);
    // After lock the floor falls back offline: it gets today's board, not the plan.
    expect(readLastBoardFor("caja", now)?.date).toBe(todayYmd);
  });

  it("wall offline with a planned day in the cache shows nothing from it", () => {
    writeRaw("2026-10-02");
    expect(readLastBoardFor("caja", now)).toBeNull();
  });

  it("wall offline since yesterday does not show yesterday as today", () => {
    writeRaw("2026-09-25");
    expect(readLastBoardFor("caja", now)).toBeNull();
  });

  it("wall offline overnight: a refused cache clears the day it had up", () => {
    writeRaw("2026-09-25");
    // WallBoard sets its day to this on a failed fetch: null, so yesterday is not left drawn.
    expect(offlineRefreshState("caja", readLastBoardFor("caja", now)).day).toBeNull();
    writeRaw(todayYmd);
    expect(offlineRefreshState("caja", readLastBoardFor("caja", now)).day).toEqual(board(todayYmd));
  });

  it("an old cache written before this rule is refused unless it is today", () => {
    writeRaw("2026-12-24");
    expect(readLastBoard(now)).toBeNull();
    writeRaw(todayYmd);
    expect(readLastBoard(now)?.date).toBe(todayYmd);
  });
});

describe("staff panels (return prompts, tareas) never keep another day", () => {
  const today = { board: "caja" as const, date: "2026-09-26" };
  const planned = { board: "caja" as const, date: "2026-10-02" };

  it("401 on the day on screen clears the panel", () => {
    expect(panelResponse(401, today, today)).toBe("clear");
  });

  it("a late response for a day no longer on screen is dropped, whatever its status", () => {
    expect(panelResponse(200, today, planned)).toBe("drop");
    expect(panelResponse(401, today, planned)).toBe("drop");
    expect(panelResponse(200, { board: "cocina", date: today.date }, today)).toBe("drop");
  });

  it("OK on the day on screen applies; another failure keeps today's panel (offline)", () => {
    expect(panelResponse(200, today, today)).toBe("apply");
    expect(panelResponse(503, today, today)).toBe("keep");
  });
});

describe("wall rush notice never uses another day's forecast", () => {
  const forecast = { weekday: 5, ranges: [{ startHour: 11, endHour: 13 }] };

  it("a forecast held from yesterday gives no notice after midnight", () => {
    const held = { board: "caja" as const, date: "2026-09-26", forecast };
    expect(forecastForScreen(held, { board: "caja", date: "2026-09-27" })).toBeNull();
    expect(forecastForScreen(held, { board: "cocina", date: "2026-09-26" })).toBeNull();
    expect(forecastForScreen(null, { board: "caja", date: "2026-09-26" })).toBeNull();
  });

  it("today's held forecast still counts while offline", () => {
    const held = { board: "caja" as const, date: "2026-09-26", forecast };
    expect(forecastForScreen(held, { board: "caja", date: "2026-09-26" })).toBe(forecast);
  });
});
