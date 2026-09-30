/**
 * B4 D2: code-only sign-in, the picker, the stripe, and the staff-page leak fix.
 * Made-up codes and a fixed test pepper only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { GET as boardDay } from "@/app/api/boards/[board]/days/[date]/route";
import { GET as listTareas, PATCH as patchTarea } from "@/app/api/tareas/route";
import { GET as listPositionMoves } from "@/app/api/position-moves/route";
import { GET as listRemovals } from "@/app/api/shift-removals/route";
import { DELETE as clearMine, GET as getMine, POST as postMine } from "@/app/api/breaks/mine/route";
import { POST as postSession } from "@/app/api/breaks/session/route";
import { TimelinePanel } from "@/components/board/TimelinePanel";
import { SchedulePanel } from "@/components/board/SchedulePanel";
import type { DayBoardDto } from "@/components/board/types";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { reservePasscodeAttempt } from "@/lib/breaks/attempts";
import { dropBreakForShift, dropImportedBreaks } from "@/lib/breaks/import-drop";
import {
  breakLengthMinutes,
  breakLengthsForStart,
  boardKioskReturnHref,
  breakQuarterFaces,
  breakSaveLine,
  breakStartChoices,
  preferredBreakLength,
  shiftAllowanceLine,
  staffBreakHref,
} from "@/lib/breaks/picker-steps";
import { blockedBreakQuarters, offeredBreakSlots } from "@/lib/breaks/mine";
import { TIMEZONE } from "@/lib/constants";
import { hashStaffPasscode, newPasscodeSalt, passcodeMatches } from "@/lib/breaks/passcode";
import { BREAK_REFUSAL_TEXT } from "@/lib/breaks/messages";
import { readStaffSession, signStaffSession } from "@/lib/breaks/session";
import { signInWithCode } from "@/lib/breaks/sign-in";
import { breakStripeLabel } from "@/lib/breaks/stripe-label";
import { saveBreak } from "@/lib/breaks/rules";
import { calendarWeekday } from "@/lib/breaks/rules";
import { chicagoDateOffset } from "@/lib/date-math";
import { messagesFor } from "@/lib/i18n";
import { requireManagerSession } from "@/lib/managers/require-session";
import { readManagerSession, signManagerSession } from "@/lib/managers/session";
import { chicagoDateTime } from "@/lib/time";
import { chicagoToday } from "@/lib/upcoming/source";
import { removeShift, restoreShift } from "@/lib/shifts/remove-restore";
import * as passcode from "@/lib/breaks/passcode";

const prisma = new PrismaClient();
const stamp = `b4d2-${Date.now()}`;
const CODE = "9182";
const LEAK = "8271";
const TEST_PEPPER = "b4-d2-test-pepper-0123456789abcdef";
const TEST_SECRET = "b4-d2-test-manager-session-secret-00";
const root = path.resolve(__dirname, "..");
const priorPepper = process.env.STAFF_PASSCODE_PEPPER;
const priorSecret = process.env.MANAGER_SESSION_SECRET;

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
const now = chicagoDateTime(wednesday, "10:00 am");

async function person(suffix: string, firstName: string, externalId = `${stamp}-${suffix}`) {
  return prisma.employee.create({
    data: { externalId, firstName, lastName: "Moss" },
  });
}

async function shiftFor(employeeId: string, date: string, board: string, start: string, end: string) {
  return prisma.shift.create({
    data: {
      employeeId,
      date,
      board,
      sourcePosition: "Cocina",
      startAt: chicagoDateTime(date, start),
      endAt: chicagoDateTime(date, end),
    },
  });
}

async function storeCode(employeeId: string, code: string) {
  const salt = newPasscodeSalt();
  const digest = await hashStaffPasscode(code, salt, TEST_PEPPER);
  await prisma.staffPasscode.create({
    data: { employeeId, hash: digest.toString("hex"), salt: salt.toString("hex") },
  });
}

function slots(date: string, start: string, end: string, board: "caja" | "cocina" = "cocina") {
  return offeredBreakSlots({
    date,
    board,
    shifts: [{
      id: "s",
      board,
      startAt: chicagoDateTime(date, start),
      endAt: chicagoDateTime(date, end),
    }],
    otherBreaks: [],
  });
}

function hasSlot(rows: { startAt: string; endAt: string }[], date: string, start: string, end: string) {
  const startAt = chicagoDateTime(date, start).toISOString();
  const endAt = chicagoDateTime(date, end).toISOString();
  return rows.some((row) => row.startAt === startAt && row.endAt === endAt);
}

describe("B4 D2 staff breaks", () => {
  beforeEach(async () => {
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    await prisma.staffPasscodeAttempt.deleteMany({ where: { board: { in: ["caja", "cocina"] } } });
  });

  afterAll(async () => {
    if (priorPepper === undefined) delete process.env.STAFF_PASSCODE_PEPPER;
    else process.env.STAFF_PASSCODE_PEPPER = priorPepper;
    if (priorSecret === undefined) delete process.env.MANAGER_SESSION_SECRET;
    else process.env.MANAGER_SESSION_SECRET = priorSecret;
    const people = await prisma.employee.findMany({
      where: { OR: [{ externalId: { startsWith: stamp } }, { externalId: { in: [CODE, LEAK] } }] },
      select: { id: true },
    });
    const ids = people.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.staffBreak.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.staffPasscode.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.tareaAssignment.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.positionMoveLog.deleteMany({ where: { employeeId: { in: ids } } });
      const removals = await prisma.shiftRemoval.findMany({
        where: { OR: [{ externalId: { startsWith: stamp } }, { externalId: { in: [CODE, LEAK] } }] },
        select: { id: true },
      });
      const removalIds = removals.map((row) => row.id);
      if (removalIds.length > 0) {
        await prisma.shiftRemovalEvent.deleteMany({ where: { overrideId: { in: removalIds } } });
        await prisma.shiftRemoval.deleteMany({ where: { id: { in: removalIds } } });
      }
      await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.staffPasscodeAttempt.deleteMany({ where: { board: { in: ["caja", "cocina"] } } });
    await prisma.boardChangeLog.deleteMany({
      where: { date: { in: [wednesday, saturday, chicagoToday()] }, route: { in: Object.values(BOARD_CHANGE_ROUTES).filter((route) => route.startsWith("break.")) } },
    });
    await prisma.tareaTemplate.deleteMany({ where: { id: `${stamp}-tpl` } });
    await prisma.$disconnect();
  });

  it("signs in the one match, refuses the rest, and pauses the board", async () => {
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    const ada = await person("ada", "Ada");
    const bea = await person("bea", "Bea");
    await shiftFor(ada.id, wednesday, "cocina", "8:00 am", "4:00 pm");
    await shiftFor(ada.id, wednesday, "cocina", "5:00 pm", "6:00 pm");
    await shiftFor(bea.id, wednesday, "caja", "8:00 am", "4:00 pm");
    await storeCode(ada.id, CODE);
    await storeCode(bea.id, "7269");

    const spy = vi.spyOn(passcode, "passcodeMatches");
    spy.mockClear();
    const signed = await signInWithCode("cocina", CODE, now);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.name).toBe("Ada Moss");
    expect(signed.token.startsWith("staff:")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    const claims = readStaffSession(signed.token);
    expect(claims?.employeeId).toBe(ada.id);
    expect(claims?.board).toBe("cocina");
    expect(readManagerSession(signed.token)).toBeNull();
    expect(readStaffSession(signManagerSession({ id: "m", name: "Ana" }))).toBeNull();
    const managerGate = await requireManagerSession(new Request("http://local/api/assignments", {
      headers: { "x-manager-session": signed.token },
    }));
    expect(managerGate.ok).toBe(false);

    spy.mockClear();
    const wrong = await signInWithCode("cocina", "0000", now);
    expect(wrong).toMatchObject({ ok: false, status: 401, error: "Ese código no coincide." });
    const offBoard = await signInWithCode("cocina", "7269", now);
    expect(offBoard).toMatchObject({ ok: true, kind: "staff" });
    const malformed = await signInWithCode("cocina", "12", now);
    expect(malformed).toMatchObject({ ok: false, error: "Ese código no coincide." });
    expect(spy.mock.calls.length).toBe(4);

    await prisma.staffPasscodeAttempt.deleteMany({ where: { board: "cocina" } });
    const pausedAt = new Date(now.getTime() + 60_000);
    for (let n = 0; n < 4; n += 1) {
      const wrongTry = await signInWithCode("cocina", "1111", pausedAt);
      expect(wrongTry).toMatchObject({ ok: false, status: 401 });
    }
    const fifth = await signInWithCode("cocina", "2222", pausedAt);
    expect(fifth).toMatchObject({ ok: false, status: 401 });
    const sixth = await signInWithCode("cocina", "3333", pausedAt);
    expect(sixth).toMatchObject({ ok: false, status: 423, error: "Espera 1 minuto" });
    const during = await signInWithCode("cocina", CODE, new Date(pausedAt.getTime() + 1000));
    expect(during).toMatchObject({ ok: false, status: 423 });
    const row = await prisma.staffPasscodeAttempt.findUnique({ where: { board: "cocina" } });
    const again = await signInWithCode("cocina", "3333", new Date(pausedAt.getTime() + 2000));
    expect(again).toMatchObject({ status: 423 });
    const after = await prisma.staffPasscodeAttempt.findUnique({ where: { board: "cocina" } });
    expect(after?.failures).toBe(row?.failures);
    expect(after?.lockedUntil?.toISOString()).toBe(row?.lockedUntil?.toISOString());
    const caja = await signInWithCode("caja", "7269", pausedAt);
    expect(caja.ok).toBe(true);

    await prisma.staffPasscodeAttempt.deleteMany({ where: { board: { in: ["caja", "cocina"] } } });
    await prisma.staffPasscodeAttempt.create({
      data: { board: "cocina", failures: 4, windowStart: pausedAt, lockedUntil: null },
    });
    spy.mockClear();
    await Promise.all([
      signInWithCode("cocina", "0000", pausedAt),
      signInWithCode("cocina", "0001", pausedAt),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  }, 90_000);

  it("refuses a repeated code without names and leaves the other board alone", async () => {
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    const one = await person("one", "One");
    const two = await person("two", "Two");
    await shiftFor(one.id, wednesday, "cocina", "8:00 am", "4:00 pm");
    await shiftFor(two.id, wednesday, "cocina", "8:00 am", "4:00 pm");
    await storeCode(one.id, "3333");
    await storeCode(two.id, "3333");
    const result = await signInWithCode("cocina", "3333", now);
    expect(result).toMatchObject({ ok: false, status: 409, error: "Código repetido, pide ayuda a un gerente" });
    const log = await prisma.boardChangeLog.findFirst({
      where: { route: BOARD_CHANGE_ROUTES.breakCodeCollision, date: wednesday },
      orderBy: { createdAt: "desc" },
    });
    expect(log?.managerName).toBe("Descansos");
    expect(log?.summary).toContain("count=2");
    expect(log?.summary).not.toContain("One");
    expect(log?.summary).not.toContain("Two");
    expect(JSON.stringify(result)).not.toContain("3333");
  }, 60_000);

  it("measures sign-in across 20 candidates", async () => {
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    const ids: string[] = [];
    const saturdayNow = chicagoDateTime(saturday, "10:00 am");
    for (let n = 0; n < 20; n += 1) {
      const row = await person(`n${n}`, `N${n}`);
      ids.push(row.id);
      await shiftFor(row.id, saturday, "caja", "8:00 am", "11:00 am");
      await storeCode(row.id, String(7000 + n));
    }
    const started = performance.now();
    const result = await signInWithCode("caja", "7019", saturdayNow);
    const elapsed = performance.now() - started;
    console.info(`D2 sign-in 20 candidates: ${elapsed.toFixed(0)}ms`);
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(60_000);
    expect(ids).toHaveLength(20);
  }, 120_000);

  it("shows each start once, then the lengths for that start", () => {
    const rows = slots(wednesday, "8:00 am", "4:00 pm");
    const starts = breakStartChoices(rows);
    const eight = chicagoDateTime(wednesday, "8:00 am").toISOString();
    expect(starts.filter((start) => start === eight)).toHaveLength(1);
    expect(new Set(starts).size).toBe(starts.length);
    const lengths = breakLengthsForStart(rows, eight);
    expect(lengths.length).toBeGreaterThan(1);
    expect(lengths.every((slot) => slot.startAt === eight)).toBe(true);
    expect(breakLengthMinutes(lengths[0]!)).toBe(15);
    expect(rows.filter((slot) => slot.startAt === eight).length).toBe(lengths.length);
  });

  it("preselects the full allowance, or the longest length that still fits", () => {
    const rows = slots(wednesday, "8:00 am", "4:00 pm");
    const eight = chicagoDateTime(wednesday, "8:00 am").toISOString();
    const late = chicagoDateTime(wednesday, "3:30 pm").toISOString();
    const morning = breakLengthsForStart(rows, eight);
    const edge = breakLengthsForStart(rows, late);
    expect(breakLengthMinutes(preferredBreakLength(morning, 60)!)).toBe(60);
    expect(edge.some((slot) => breakLengthMinutes(slot) === 60)).toBe(false);
    expect(breakLengthMinutes(preferredBreakLength(edge, 60)!)).toBe(30);
    expect(preferredBreakLength([], 60)).toBeNull();
    const chosen = preferredBreakLength(edge, 60)!;
    const clock = (iso: string) => formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");
    expect(breakSaveLine(chosen, clock)).toBe("15:30 a 16:00, 30 min");
    expect(shiftAllowanceLine(
      [{ startAt: eight, endAt: chicagoDateTime(wednesday, "4:00 pm").toISOString() }],
      60,
      clock,
    )).toBe("Tu turno: 08:00 a 16:00. Te tocan 60 minutos.");
  });

  it("shows calendar quarters, with the partial first quarter Fuera", () => {
    const start = chicagoDateTime(wednesday, "8:10 am");
    const end = chicagoDateTime(wednesday, "4:10 pm");
    const shifts = [{ id: "s", board: "cocina" as const, startAt: start, endAt: end }];
    const taken = {
      board: "cocina",
      startAt: chicagoDateTime(wednesday, "9:00 am"),
      endAt: chicagoDateTime(wednesday, "9:15 am"),
    };
    const second = {
      board: "cocina",
      startAt: chicagoDateTime(wednesday, "9:00 am"),
      endAt: chicagoDateTime(wednesday, "9:30 am"),
    };
    const rows = offeredBreakSlots({ date: wednesday, board: "cocina", shifts, otherBreaks: [taken, second] });
    const blocked = blockedBreakQuarters({ date: wednesday, board: "cocina", shifts, otherBreaks: [taken, second] });
    const faces = breakQuarterFaces({
      shifts: [{ startAt: start.toISOString(), endAt: end.toISOString() }],
      slots: rows,
      blocked,
    });
    const at = (clock: string) => chicagoDateTime(wednesday, clock).toISOString();
    expect(faces[0]).toEqual({ startAt: at("8:00 am"), disabled: true, reason: "Fuera" });
    expect(faces.find((face) => face.startAt === at("8:15 am"))).toEqual({
      startAt: at("8:15 am"),
      disabled: false,
      reason: null,
    });
    expect(faces.find((face) => face.startAt === at("9:00 am"))).toEqual({
      startAt: at("9:00 am"),
      disabled: true,
      reason: "Ocupado",
    });
    expect(faces.find((face) => face.startAt === at("11:00 am"))).toEqual({
      startAt: at("11:00 am"),
      disabled: true,
      reason: "Bloqueado",
    });
    expect(faces.at(-1)).toEqual({ startAt: at("4:00 pm"), disabled: true, reason: "Fuera" });
    expect(faces.some((face) => face.startAt === start.toISOString())).toBe(false);
    expect(staffBreakHref("cocina")).toBe("/descansos?board=cocina&kiosk=1&from=board");
    expect(staffBreakHref("caja")).toBe("/descansos?board=caja&kiosk=1&from=board");
    expect(boardKioskReturnHref("board", "cocina")).toBe("/?board=cocina&kiosk=1");
    expect(boardKioskReturnHref("board", "caja")).toBe("/?board=caja&kiosk=1");
    expect(boardKioskReturnHref(null, "cocina")).toBeNull();
    expect(boardKioskReturnHref("spare", "cocina")).toBeNull();
    expect(boardKioskReturnHref("board", null)).toBeNull();
    for (const startAt of new Set(rows.map((row) => row.startAt))) {
      expect(faces).toContainEqual({ startAt, disabled: false, reason: null });
    }
  });

  it("offers only the slots assessBreak accepts", () => {
    const weekday = slots(wednesday, "8:00 am", "4:00 pm");
    expect(hasSlot(weekday, wednesday, "9:00 am", "9:15 am")).toBe(true);
    expect(hasSlot(weekday, wednesday, "9:00 am", "10:15 am")).toBe(false);
    expect(hasSlot(weekday, wednesday, "11:00 am", "11:15 am")).toBe(false);
    expect(hasSlot(weekday, wednesday, "1:00 pm", "1:15 pm")).toBe(true);
    expect(hasSlot(weekday, wednesday, "3:45 pm", "4:00 pm")).toBe(true);

    const weekend = slots(saturday, "8:00 am", "4:00 pm");
    expect(hasSlot(weekend, saturday, "11:00 am", "11:15 am")).toBe(true);

    const untilSix = slots(wednesday, "8:00 am", "6:00 pm");
    expect(hasSlot(untilSix, wednesday, "5:45 pm", "6:00 pm")).toBe(true);
    expect(hasSlot(untilSix, wednesday, "6:00 pm", "6:15 pm")).toBe(false);

    const split = offeredBreakSlots({
      date: wednesday,
      board: "cocina",
      shifts: [
        { id: "a", board: "cocina", startAt: chicagoDateTime(wednesday, "8:00 am"), endAt: chicagoDateTime(wednesday, "11:00 am") },
        { id: "b", board: "cocina", startAt: chicagoDateTime(wednesday, "2:00 pm"), endAt: chicagoDateTime(wednesday, "6:00 pm") },
      ],
      otherBreaks: [],
    });
    expect(hasSlot(split, wednesday, "8:00 am", "8:30 am")).toBe(true);
    expect(hasSlot(split, wednesday, "8:00 am", "8:45 am")).toBe(false);
    expect(hasSlot(split, wednesday, "12:00 pm", "12:15 pm")).toBe(false);
    expect(hasSlot(split, wednesday, "2:00 pm", "2:30 pm")).toBe(true);

    expect(slots(wednesday, "8:00 am", "1:00 pm").every((row) => {
      return new Date(row.endAt).getTime() - new Date(row.startAt).getTime() === 15 * 60_000;
    })).toBe(true);
    expect(hasSlot(slots(wednesday, "8:00 am", "2:00 pm"), wednesday, "8:00 am", "8:30 am")).toBe(true);
    expect(hasSlot(slots(wednesday, "8:00 am", "6:15 pm"), wednesday, "8:00 am", "9:30 am")).toBe(true);
  });

  it("saves, replaces and clears independently of the tablet board", async () => {
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    const ada = await person("save", "Save");
    await shiftFor(ada.id, chicagoToday(), "cocina", "8:00 am", "4:00 pm");
    await storeCode(ada.id, "4545");
    const signed = await signInWithCode("cocina", "4545");
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const mine = await getMine(new Request("http://local/api/breaks/mine", {
      headers: { "x-staff-session": signed.token },
    }));
    const body = await mine.json() as { slots: { startAt: string; endAt: string }[]; name: string };
    expect(body.name).toBe("Save Moss");
    expect(body.slots.length).toBeGreaterThan(0);
    const first = body.slots[0]!;
    const saved = await postMine(new Request("http://local/api/breaks/mine", {
      method: "POST",
      headers: { "x-staff-session": signed.token, "content-type": "application/json" },
      body: JSON.stringify({ startAt: first.startAt, endAt: first.endAt, date: "1999-01-01", employeeId: "nope" }),
    }));
    expect(saved.status).toBe(200);
    const second = body.slots.find((slot) => slot.startAt !== first.startAt) ?? first;
    const replaced = await postMine(new Request("http://local/api/breaks/mine", {
      method: "POST",
      headers: { "x-staff-session": signed.token, "content-type": "application/json" },
      body: JSON.stringify({ startAt: second.startAt, endAt: second.endAt }),
    }));
    const replacedBody = await replaced.json() as { replaced: boolean };
    expect(replacedBody.replaced).toBe(true);
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(1);

    const outside = await postMine(new Request("http://local/api/breaks/mine", {
      method: "POST",
      headers: { "x-staff-session": signed.token, "content-type": "application/json" },
      body: JSON.stringify({
        startAt: chicagoDateTime(chicagoToday(), "9:00 am").toISOString(),
        endAt: chicagoDateTime(chicagoToday(), "9:00 am").toISOString(),
      }),
    }));
    expect(await outside.json()).toMatchObject({ error: BREAK_REFUSAL_TEXT.DURATION });

    const cajaToken = signStaffSession({ employeeId: ada.id, board: "caja" });
    const mismatch = await postMine(new Request("http://local/api/breaks/mine", {
      method: "POST",
      headers: { "x-staff-session": cajaToken, "content-type": "application/json" },
      body: JSON.stringify({ startAt: second.startAt, endAt: second.endAt }),
    }));
    expect(mismatch.status).toBe(200);
    expect((await prisma.staffBreak.findFirstOrThrow({ where: { employeeId: ada.id } })).board).toBe("cocina");
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(1);

    const managerMine = await getMine(new Request("http://local/api/breaks/mine", {
      headers: { "x-staff-session": signManagerSession({ id: "m", name: "Ana" }) },
    }));
    expect(managerMine.status).toBe(401);
    const expired = signStaffSession({ employeeId: ada.id, board: "cocina" }, -1);
    expect((await getMine(new Request("http://local/api/breaks/mine", {
      headers: { "x-staff-session": expired },
    }))).status).toBe(401);

    const cleared = await clearMine(new Request("http://local/api/breaks/mine", {
      method: "DELETE",
      headers: { "x-staff-session": signed.token },
    }));
    expect(await cleared.json()).toMatchObject({ cleared: true });
    const clearLog = await prisma.boardChangeLog.findFirst({
      where: { route: BOARD_CHANGE_ROUTES.breakClear, managerId: ada.id },
    });
    expect(clearLog).toBeTruthy();
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(0);
  }, 60_000);

  it("leaves two breaks when three saves take one quarter", async () => {
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    const left = await person("left", "Left");
    const right = await person("right", "Right");
    const mid = await person("mid-ceiling", "Mid");
    const date = chicagoDateOffset(wednesday, 21);
    await shiftFor(left.id, date, "cocina", "8:00 am", "4:00 pm");
    await shiftFor(right.id, date, "cocina", "8:00 am", "4:00 pm");
    await shiftFor(mid.id, date, "cocina", "8:00 am", "4:00 pm");
    const startAt = chicagoDateTime(date, "9:00 am");
    const endAt = chicagoDateTime(date, "9:15 am");
    const results = await Promise.allSettled([
      saveBreak({ employeeId: left.id, date, startAt, endAt, expectedBoard: "cocina" }),
      saveBreak({ employeeId: right.id, date, startAt, endAt, expectedBoard: "cocina" }),
      saveBreak({ employeeId: mid.id, date, startAt, endAt, expectedBoard: "cocina" }),
    ]);
    const wins = results.filter((row) => row.status === "fulfilled");
    expect(wins).toHaveLength(2);
    expect(await prisma.staffBreak.count({ where: { date, board: "cocina", employeeId: { in: [left.id, right.id, mid.id] } } })).toBe(2);
  });

  it("drops a break when the shift is superseded, removed, or no longer fits", async () => {
    const ada = await person("drop", "Drop");
    const date = chicagoDateOffset(wednesday, 28);
    const kept = await shiftFor(ada.id, date, "cocina", "8:00 am", "4:00 pm");
    const dead = await shiftFor(ada.id, date, "cocina", "8:00 am", "4:00 pm");
    const removed = await shiftFor(ada.id, date, "cocina", "8:00 am", "4:00 pm");
    await prisma.staffBreak.create({
      data: {
        employeeId: ada.id, shiftId: kept.id, board: "cocina", date,
        startAt: chicagoDateTime(date, "9:00 am"), endAt: chicagoDateTime(date, "9:15 am"), actor: ada.id,
      },
    });
    await dropImportedBreaks(prisma as unknown as Parameters<typeof dropImportedBreaks>[0], {
      supersededShiftIds: [],
      changedShiftIds: [kept.id],
      boardRemovedShiftIds: [],
    });
    expect(await prisma.staffBreak.count({ where: { shiftId: kept.id } })).toBe(1);

    await prisma.shift.update({
      where: { id: kept.id },
      data: { startAt: chicagoDateTime(date, "2:00 pm"), endAt: chicagoDateTime(date, "4:00 pm") },
    });
    await prisma.staffBreak.update({
      where: { employeeId_date: { employeeId: ada.id, date } },
      data: { shiftId: kept.id },
    });
    await dropImportedBreaks(prisma as unknown as Parameters<typeof dropImportedBreaks>[0], {
      supersededShiftIds: [],
      changedShiftIds: [kept.id],
      boardRemovedShiftIds: [],
    });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id, date } })).toBe(0);
    const unfit = await prisma.boardChangeLog.findFirst({ where: { route: BOARD_CHANGE_ROUTES.breakImportDrop, date } });
    expect(unfit?.managerName).toBe("Descansos");
    expect(unfit?.summary).not.toContain("Drop");

    await prisma.staffBreak.create({
      data: {
        employeeId: ada.id, shiftId: dead.id, board: "cocina", date,
        startAt: chicagoDateTime(date, "9:00 am"), endAt: chicagoDateTime(date, "9:15 am"), actor: ada.id,
      },
    });
    await prisma.shift.update({ where: { id: dead.id }, data: { supersededAt: new Date() } });
    await dropImportedBreaks(prisma as unknown as Parameters<typeof dropImportedBreaks>[0], {
      supersededShiftIds: [dead.id],
      changedShiftIds: [],
      boardRemovedShiftIds: [],
    });
    expect(await prisma.staffBreak.count({ where: { shiftId: dead.id } })).toBe(0);

    await prisma.staffBreak.create({
      data: {
        employeeId: ada.id, shiftId: removed.id, board: "cocina", date,
        startAt: chicagoDateTime(date, "9:30 am"), endAt: chicagoDateTime(date, "9:45 am"), actor: ada.id,
      },
    });
    const before = await prisma.assignment.findMany({ where: { employeeId: ada.id } });
    await removeShift({
      shiftId: removed.id,
      board: "cocina",
      date,
      expected: {
        startAt: removed.startAt.toISOString(),
        endAt: removed.endAt.toISOString(),
        employeeId: ada.id,
        sourcePosition: "Cocina",
      },
      expectedRevision: 0,
      reason: "test drop",
      manager: { id: ada.id, name: "Drop Moss" },
    });
    expect(await prisma.staffBreak.count({ where: { shiftId: removed.id } })).toBe(0);
    expect(await prisma.assignment.findMany({ where: { employeeId: ada.id } })).toEqual(before);
    const override = await prisma.shiftRemoval.findFirst({ where: { shiftId: removed.id } });
    await restoreShift({
      id: override!.id,
      expectedRevision: override!.revision,
      expected: {
        startAt: removed.startAt.toISOString(),
        endAt: removed.endAt.toISOString(),
        employeeId: ada.id,
        sourcePosition: "Cocina",
      },
      positions: "none",
      reason: "test restore",
      manager: { id: ada.id, name: "Drop Moss" },
    });
    expect(await prisma.staffBreak.count({ where: { shiftId: removed.id } })).toBe(0);
    expect(dropBreakForShift).toBeTypeOf("function");
  });

  it("drops a break on the unchanged shift when the other shift cuts the allowance", async () => {
    const ada = await person("split", "Split");
    const date = chicagoDateOffset(wednesday, 42);
    const morning = await shiftFor(ada.id, date, "cocina", "8:00 am", "2:00 pm");
    const afternoon = await shiftFor(ada.id, date, "cocina", "2:00 pm", "6:00 pm");
    const tx = prisma as unknown as Parameters<typeof dropImportedBreaks>[0];
    const saveMorning = async (end: string) => {
      await prisma.staffBreak.create({
        data: {
          employeeId: ada.id, shiftId: morning.id, board: "cocina", date,
          startAt: chicagoDateTime(date, "8:00 am"), endAt: chicagoDateTime(date, end), actor: ada.id,
        },
      });
    };

    await saveMorning("9:00 am");
    await dropImportedBreaks(tx, {
      supersededShiftIds: [],
      changedShiftIds: [afternoon.id],
      boardRemovedShiftIds: [],
    });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id, date } })).toBe(1);

    await prisma.shift.update({
      where: { id: afternoon.id },
      data: { endAt: chicagoDateTime(date, "3:00 pm") },
    });
    await dropImportedBreaks(tx, {
      supersededShiftIds: [],
      changedShiftIds: [afternoon.id],
      boardRemovedShiftIds: [],
    });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id, date } })).toBe(0);
    const shortened = await prisma.boardChangeLog.findFirst({
      where: { route: BOARD_CHANGE_ROUTES.breakImportDrop, date },
    });
    expect(shortened?.managerName).toBe("Descansos");
    expect(shortened?.summary).not.toContain("Split");

    await saveMorning("8:15 am");
    await dropImportedBreaks(tx, {
      supersededShiftIds: [],
      changedShiftIds: [afternoon.id],
      boardRemovedShiftIds: [],
    });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id, date } })).toBe(1);
    await prisma.staffBreak.deleteMany({ where: { employeeId: ada.id, date } });

    await prisma.shift.update({
      where: { id: afternoon.id },
      data: { endAt: chicagoDateTime(date, "6:00 pm"), supersededAt: null },
    });
    await saveMorning("9:00 am");
    await prisma.shift.update({ where: { id: afternoon.id }, data: { supersededAt: new Date() } });
    await dropImportedBreaks(tx, {
      supersededShiftIds: [afternoon.id],
      changedShiftIds: [],
      boardRemovedShiftIds: [],
    });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id, date } })).toBe(0);
    await prisma.boardChangeLog.deleteMany({ where: { date, route: BOARD_CHANGE_ROUTES.breakImportDrop } });
  });

  it("stripes only the overlapping hour and leaves paint untouched", async () => {
    const ada = await person("stripe", "Stripe", CODE);
    const date = chicagoToday();
    const shift = await shiftFor(ada.id, date, "cocina", "8:00 am", "4:00 pm");
    const station = await prisma.station.findFirst({ where: { board: "cocina" } });
    expect(station).toBeTruthy();
    const assignment = await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId: ada.id,
        stationId: station!.id,
        hourStart: chicagoDateTime(date, "9:00 am"),
        hourEnd: chicagoDateTime(date, "10:00 am"),
      },
    });
    const paintBefore = JSON.stringify(await prisma.assignment.findMany({ where: { employeeId: ada.id } }));
    const marksBefore = JSON.stringify(await prisma.mandatoryMark.findMany({ where: { date } }));
    await saveBreak({
      employeeId: ada.id,
      date,
      startAt: chicagoDateTime(date, "9:15 am"),
      endAt: chicagoDateTime(date, "9:30 am"),
    });
    expect(JSON.stringify(await prisma.assignment.findMany({ where: { employeeId: ada.id } }))).toBe(paintBefore);
    expect(JSON.stringify(await prisma.mandatoryMark.findMany({ where: { date } }))).toBe(marksBefore);

    const response = await boardDay(new Request(`http://local/api/boards/cocina/days/${date}`), {
      params: Promise.resolve({ board: "cocina", date }),
    });
    const day = await response.json() as DayBoardDto;
    expect(JSON.stringify(day)).not.toContain(CODE);
    expect(day.breaks?.some((row) => row.employeeId === ada.id && row.shiftId === shift.id)).toBe(true);
    const label = breakStripeLabel(
      day.breaks,
      ada.id,
      shift.id,
      chicagoDateTime(date, "9:00 am"),
      chicagoDateTime(date, "10:00 am"),
    );
    expect(label).toBe("9:15 AM-9:30 AM");
    expect(breakStripeLabel(day.breaks, ada.id, shift.id, chicagoDateTime(date, "10:00 am"), chicagoDateTime(date, "11:00 am"))).toBeNull();

    const withManager = await boardDay(new Request(`http://local/api/boards/cocina/days/${date}`, {
      headers: { "x-manager-session": signManagerSession({ id: "not-a-manager", name: "No" }) },
    }), { params: Promise.resolve({ board: "cocina", date }) });
    expect(JSON.stringify(await withManager.json())).not.toContain(CODE);

    const markupDay: DayBoardDto = {
      ...day,
      shifts: day.shifts.filter((row) => row.id === shift.id).map((row) => ({
        ...row,
        employee: { ...row.employee, externalId: CODE },
      })),
    };
    const timeline = renderToStaticMarkup(createElement(TimelinePanel, {
      day: markupDay,
      date,
      locale: "es",
      t: messagesFor("es"),
      selectedHour: 9,
    }));
    const schedule = renderToStaticMarkup(createElement(SchedulePanel, {
      day: markupDay,
      date,
      locale: "es",
      t: messagesFor("es"),
    }));
    expect(timeline).toContain("data-testid=\"break-stripe\"");
    expect(timeline).not.toContain(CODE);
    expect(schedule).not.toContain(CODE);
    expect(schedule).not.toContain("data-employee");
    expect(assignment.id).toBeTruthy();
  });

  it("keeps the code off tareas and position moves, and on shift removal", async () => {
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    const ada = await person("leak", "Leak", LEAK);
    const date = chicagoToday();
    const shift = await shiftFor(ada.id, date, "cocina", "8:00 am", "4:00 pm");
    await prisma.tareaTemplate.upsert({
      where: { id: `${stamp}-tpl` },
      create: { id: `${stamp}-tpl`, code: `${stamp}-tpl`, label: "Trapear", mode: "normal", sortOrder: 99, board: "cocina" },
      update: {},
    });
    const assignment = await prisma.tareaAssignment.create({
      data: { date, employeeId: ada.id, templateId: `${stamp}-tpl` },
    });
    await prisma.positionMoveLog.create({
      data: { date, hour: 9, employeeId: ada.id, reason: "Other" },
    });
    const tareas = await listTareas(new Request(`http://local/api/tareas?date=${date}&board=cocina`));
    const patched = await patchTarea(new Request("http://local/api/tareas", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: assignment.id, status: "done" }),
    }));
    const moves = await listPositionMoves(new Request(`http://local/api/position-moves?date=${date}`));
    expect(JSON.stringify(await tareas.json())).not.toContain(LEAK);
    expect(JSON.stringify(await patched.json())).not.toContain(LEAK);
    expect(JSON.stringify(await moves.json())).not.toContain(LEAK);

    await removeShift({
      shiftId: shift.id,
      board: "cocina",
      date,
      expected: {
        startAt: shift.startAt.toISOString(),
        endAt: shift.endAt.toISOString(),
        employeeId: ada.id,
        sourcePosition: "Cocina",
      },
      expectedRevision: 0,
      reason: "leak check",
      manager: { id: ada.id, name: "Leak Moss" },
    });
    const manager = await prisma.manager.findFirst({ where: { active: true } });
    expect(manager).toBeTruthy();
    const token = signManagerSession({ id: manager!.id, name: manager!.name });
    const removals = await listRemovals(new Request(`http://local/api/shift-removals?board=cocina&date=${date}`, {
      headers: { "x-manager-session": token },
    }));
    expect(JSON.stringify(await removals.json())).toContain(LEAK);
  });

  it("adds the pause table without a data-loss reset", () => {
    const rootEnv = process.env.FLOOR_BOARDS_TEST_ROOT;
    expect(rootEnv).toBeTruthy();
    const dir = fs.mkdtempSync(path.join(rootEnv!, "d2-schema-"));
    const db = path.join(dir, "populated.db");
    const schemaPath = path.join(dir, "schema.prisma");
    const current = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
    const older = current.replace(/\/\/\/ One keypad pause[\s\S]*?model StaffPasscodeAttempt \{[\s\S]*?\}\n/, "");
    expect(older).not.toContain("model StaffPasscodeAttempt");
    fs.writeFileSync(schemaPath, older);
    const push = (schema?: string) => execFileSync(
      "pnpm",
      ["exec", "prisma", "db", "push", "--skip-generate", ...(schema ? ["--schema", schema] : [])],
      { cwd: root, env: { ...process.env, DATABASE_URL: `file:${db}` }, encoding: "utf8" },
    );
    push(schemaPath);
    const old = new PrismaClient({ datasources: { db: { url: `file:${db}` } } });
    return old.employee.create({
      data: { externalId: `${stamp}-old`, firstName: "Old", lastName: "Row" },
    }).then(async (created) => {
      await old.$disconnect();
      const output = push();
      expect(output.toLowerCase()).not.toContain("data loss");
      const next = new PrismaClient({ datasources: { db: { url: `file:${db}` } } });
      const found = await next.employee.findUnique({ where: { id: created.id } });
      expect(found?.firstName).toBe("Old");
      await next.$disconnect();
    });
  });

  it("refuses a bad board before it reserves a try", async () => {
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
    process.env.MANAGER_SESSION_SECRET = TEST_SECRET;
    await prisma.staffPasscodeAttempt.deleteMany({ where: { board: "caja" } });
    const response = await postSession(new Request("http://local/api/breaks/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ board: "wall", code: CODE }),
    }));
    expect(response.status).toBe(400);
    expect(await prisma.staffPasscodeAttempt.findUnique({ where: { board: "caja" } })).toBeNull();
    delete process.env.STAFF_PASSCODE_PEPPER;
    const missing = await postSession(new Request("http://local/api/breaks/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ board: "cocina", code: CODE }),
    }));
    expect(missing.status).toBe(503);
    expect((await missing.json()).error).toBe("BREAK no configurado");
    const reserved = await reservePasscodeAttempt("cocina");
    expect(reserved).toBe("reserved");
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
  });
});

