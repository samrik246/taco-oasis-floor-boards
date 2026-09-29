import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BOARD_CHANGE_ROUTES, writeBoardChange } from "@/lib/board-change-log";
import { TIMEZONE } from "@/lib/constants";
import { chicagoDateOffset } from "@/lib/date-math";
import { chicagoDateTime } from "@/lib/time";

const MINUTE_MS = 60_000;

/** First try plus two retries, then a conflict. */
export const BREAK_LOCK_ATTEMPTS = 3;

export class BreakRefused extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export type BreakWindow = { start: Date; end: Date };

/** Present only on the manager path. Staff saves and clears omit it. */
export type BreakManagerActor = { id: string; name: string; kind: "manager" };

const BREAK_TX = { maxWait: 1_000, timeout: 8_000 } as const;

export type BreakShift = {
  id: string;
  board: string;
  startAt: Date;
  endAt: Date;
  supersededAt?: Date | null;
  boardRemoved?: boolean;
};

/** Weekday from the YYYY-MM-DD calendar parts. Sunday is 0. */
export function calendarWeekday(dateYmd: string): number {
  const [year, month, day] = dateYmd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The only blocked windows. Half-open. Lunch is Monday-Friday.
 * 18:00 through the next Chicago midnight is every day. The board argument
 * stays for a later sales feed.
 */
export function breakBlackouts(date: string, _board: string): BreakWindow[] {
  const windows: BreakWindow[] = [];
  const weekday = calendarWeekday(date);
  if (weekday >= 1 && weekday <= 5) {
    windows.push({
      start: chicagoDateTime(date, "11:00 am"),
      end: chicagoDateTime(date, "1:00 pm"),
    });
  }
  windows.push({
    start: chicagoDateTime(date, "6:00 pm"),
    end: chicagoDateTime(chicagoDateOffset(date, 1), "12:00 am"),
  });
  return windows;
}

/** Whole scheduled minutes on caja and cocina. Superseded, board-removed, and other boards do not count. */
export function scheduledMinutes(shifts: readonly BreakShift[]): number {
  let ms = 0;
  for (const shift of shifts) {
    if (shift.supersededAt || shift.boardRemoved) continue;
    if (shift.board !== "caja" && shift.board !== "cocina") continue;
    ms += shift.endAt.getTime() - shift.startAt.getTime();
  }
  return Math.floor(ms / MINUTE_MS);
}

/** Under 6 h is 15. 6:00–7:59 is 30. 8:00–10:00 is 60. Over 10 h is 90. */
export function breakAllowanceMinutes(minutes: number): 15 | 30 | 60 | 90 {
  if (minutes < 360) return 15;
  if (minutes < 480) return 30;
  if (minutes <= 600) return 60;
  return 90;
}

export function intervalsOverlap(start: Date, end: Date, otherStart: Date, otherEnd: Date): boolean {
  return start.getTime() < otherEnd.getTime() && otherStart.getTime() < end.getTime();
}

function isChicagoQuarterHour(instant: Date): boolean {
  const local = toZonedTime(instant, TIMEZONE);
  return local.getMinutes() % 15 === 0 && local.getSeconds() === 0 && local.getMilliseconds() === 0;
}

function currentShift(shift: BreakShift): boolean {
  return !shift.supersededAt && !shift.boardRemoved;
}

/**
 * Placement, allowance, blackout and same-board overlap.
 * Blackout windows come only from breakBlackouts.
 */
export function assessBreak(input: {
  date: string;
  startAt: Date;
  endAt: Date;
  shifts: readonly BreakShift[];
  otherBreaks: readonly { board: string; startAt: Date; endAt: Date }[];
}): { code: string } | { shiftId: string; board: string } {
  if (!isChicagoQuarterHour(input.startAt) || !isChicagoQuarterHour(input.endAt)) {
    return { code: "ALIGNMENT" };
  }
  const duration = (input.endAt.getTime() - input.startAt.getTime()) / MINUTE_MS;
  if (!Number.isInteger(duration) || duration < 15 || duration % 15 !== 0) {
    return { code: "DURATION" };
  }
  const containers = input.shifts.filter((shift) => {
    return currentShift(shift)
      && input.startAt.getTime() >= shift.startAt.getTime()
      && input.endAt.getTime() <= shift.endAt.getTime();
  });
  const held = containers.find((shift) => shift.board === "caja" || shift.board === "cocina");
  if (!held) {
    return { code: containers.some((shift) => shift.board === "other") ? "OTHER_BOARD" : "OUTSIDE_SHIFT" };
  }
  const allowance = breakAllowanceMinutes(scheduledMinutes(input.shifts));
  if (duration > allowance) return { code: "ALLOWANCE" };
  for (const window of breakBlackouts(input.date, held.board)) {
    if (intervalsOverlap(input.startAt, input.endAt, window.start, window.end)) return { code: "BLACKOUT" };
  }
  for (const other of input.otherBreaks) {
    if (other.board !== held.board) continue;
    if (intervalsOverlap(input.startAt, input.endAt, other.startAt, other.endAt)) return { code: "OVERLAP" };
  }
  return { shiftId: held.id, board: held.board };
}

function isBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  // P1008 is the SQLite connector giving up while another writer holds the file.
  return code === "P2034" || code === "P1008" || /SQLITE_BUSY|database is locked/i.test(message);
}

export type ClearRead = {
  id: string;
  updatedAtMs: number;
  startAtMs: number;
  endAtMs: number;
};

/**
 * Test seam. The clear commits its read, then this runs, then it deletes only
 * if that same row is still there. The mini has no test root, so this stays unset.
 */
let afterClearRead: ((snapshot: ClearRead | null) => Promise<void>) | null = null;

export function setAfterClearReadForTests(
  probe: ((snapshot: ClearRead | null) => Promise<void>) | null,
): void {
  if (!process.env.FLOOR_BOARDS_TEST_ROOT) {
    throw new Error("break read probe requires the test root");
  }
  afterClearRead = probe;
}

async function liveBreaks(
  tx: Prisma.TransactionClient,
  rows: readonly { id?: string; shiftId: string; board: string; startAt: Date; endAt: Date }[],
): Promise<{ board: string; startAt: Date; endAt: Date }[]> {
  if (rows.length === 0) return [];
  const live = await tx.shift.findMany({
    where: {
      id: { in: rows.map((row) => row.shiftId) },
      supersededAt: null,
      boardRemoved: false,
    },
    select: { id: true },
  });
  const liveIds = new Set(live.map((shift) => shift.id));
  return rows
    .filter((row) => liveIds.has(row.shiftId))
    .map((row) => ({ board: row.board, startAt: row.startAt, endAt: row.endAt }));
}

async function withBreakLock<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= BREAK_LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (!isBusy(error) || attempt === BREAK_LOCK_ATTEMPTS) {
        if (isBusy(error)) throw new BreakRefused("LOCK_CONFLICT");
        throw error;
      }
    }
  }
  throw new BreakRefused("LOCK_CONFLICT");
}

async function writeBreak(
  input: {
    employeeId: string;
    date: string;
    startAt: Date;
    endAt: Date;
    expectedBoard?: "caja" | "cocina";
    actor?: BreakManagerActor;
  },
): Promise<{ id: string; replaced: boolean }> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.staffBreakLock.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { updatedAt: new Date() },
    });
    const employee = await tx.employee.findUnique({
      where: { id: input.employeeId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!employee) throw new BreakRefused("NOT_FOUND");
    const shifts = await tx.shift.findMany({ where: { employeeId: input.employeeId, date: input.date } });
    const others = await tx.staffBreak.findMany({
      where: { date: input.date, employeeId: { not: input.employeeId } },
      select: { shiftId: true, board: true, startAt: true, endAt: true },
    });
    const decision = assessBreak({
      date: input.date,
      startAt: input.startAt,
      endAt: input.endAt,
      shifts,
      otherBreaks: await liveBreaks(tx, others),
    });
    if ("code" in decision) throw new BreakRefused(decision.code);
    if (input.expectedBoard && decision.board !== input.expectedBoard) {
      throw new BreakRefused("BOARD_MISMATCH");
    }
    const existing = await tx.staffBreak.findUnique({
      where: { employeeId_date: { employeeId: input.employeeId, date: input.date } },
      select: { id: true, board: true },
    });
    if (input.expectedBoard && existing && existing.board !== input.expectedBoard) {
      throw new BreakRefused("BOARD_MISMATCH");
    }
    const manager = input.actor?.kind === "manager" ? input.actor : null;
    const actorId = manager ? manager.id : employee.id;
    const saved = existing
      ? await tx.staffBreak.update({
        where: { id: existing.id },
        data: {
          shiftId: decision.shiftId,
          board: decision.board,
          startAt: input.startAt,
          endAt: input.endAt,
          actor: actorId,
        },
      })
      : await tx.staffBreak.create({
        data: {
          employeeId: employee.id,
          shiftId: decision.shiftId,
          board: decision.board,
          date: input.date,
          startAt: input.startAt,
          endAt: input.endAt,
          actor: actorId,
        },
      });
    await writeBoardChange(tx, {
      id: actorId,
      name: manager ? manager.name : `${employee.firstName} ${employee.lastName}`.trim(),
      route: manager ? BOARD_CHANGE_ROUTES.breakManagerSave : BOARD_CHANGE_ROUTES.breakSave,
    }, {
      date: input.date,
      count: 1,
      breakStart: formatInTimeZone(input.startAt, TIMEZONE, "HH:mm"),
      breakEnd: formatInTimeZone(input.endAt, TIMEZONE, "HH:mm"),
      ...(manager ? { employeeId: employee.id } : {}),
    });
    return { id: saved.id, replaced: existing != null };
  }, BREAK_TX);
}

/** One transaction. A busy lock is retried, then refused. A failed save leaves the old row. */
export async function saveBreak(input: {
  employeeId: string;
  date: string;
  startAt: Date;
  endAt: Date;
  /** When set, a shift or an existing row on the other board is refused and left in place. */
  expectedBoard?: "caja" | "cocina";
  /** Manager id and name. Absent, the row and the log stay the employee's. */
  actor?: BreakManagerActor;
}): Promise<{ id: string; replaced: boolean }> {
  return withBreakLock(() => writeBreak(input));
}

function sameClearRead(existing: { id: string; updatedAt: Date; startAt: Date; endAt: Date }, snapshot: ClearRead): boolean {
  return existing.id === snapshot.id
    && existing.updatedAt.getTime() === snapshot.updatedAtMs
    && existing.startAt.getTime() === snapshot.startAtMs
    && existing.endAt.getTime() === snapshot.endAtMs;
}

async function readClearSnapshot(input: {
  employeeId: string;
  date: string;
}): Promise<ClearRead | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.staffBreakLock.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { updatedAt: new Date() },
    });
    const existing = await tx.staffBreak.findUnique({
      where: { employeeId_date: { employeeId: input.employeeId, date: input.date } },
      select: { id: true, updatedAt: true, startAt: true, endAt: true },
    });
    if (!existing) return null;
    return {
      id: existing.id,
      updatedAtMs: existing.updatedAt.getTime(),
      startAtMs: existing.startAt.getTime(),
      endAtMs: existing.endAt.getTime(),
    };
  }, BREAK_TX);
}

async function writeClear(input: {
  employeeId: string;
  date: string;
  board: "caja" | "cocina";
  actor?: BreakManagerActor;
}): Promise<{ cleared: boolean }> {
  const snapshot = await readClearSnapshot(input);
  if (afterClearRead) await afterClearRead(snapshot);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.staffBreakLock.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { updatedAt: new Date() },
    });
    const existing = await tx.staffBreak.findUnique({
      where: { employeeId_date: { employeeId: input.employeeId, date: input.date } },
    });
    const manager = input.actor?.kind === "manager" ? input.actor : null;
    if (manager) {
      if (existing && existing.board !== input.board) throw new BreakRefused("BOARD_MISMATCH");
      const live = await tx.shift.findFirst({
        where: {
          employeeId: input.employeeId,
          date: input.date,
          board: input.board,
          supersededAt: null,
          boardRemoved: false,
        },
        select: { id: true },
      });
      if (!live) throw new BreakRefused("OUTSIDE_SHIFT");
      if (!existing) return { cleared: false };
    } else {
      if (!existing) return { cleared: false };
      if (existing.board !== input.board) throw new BreakRefused("BOARD_MISMATCH");
    }
    if (!snapshot || !sameClearRead(existing, snapshot)) throw new BreakRefused("LOCK_CONFLICT");
    await tx.staffBreak.delete({ where: { id: existing.id } });
    if (manager) {
      await writeBoardChange(tx, {
        id: manager.id,
        name: manager.name,
        route: BOARD_CHANGE_ROUTES.breakManagerClear,
      }, {
        date: input.date,
        count: 1,
        board: input.board,
        employeeId: input.employeeId,
      });
    } else {
      const employee = await tx.employee.findUnique({
        where: { id: input.employeeId },
        select: { id: true, firstName: true, lastName: true },
      });
      await writeBoardChange(tx, {
        id: employee?.id ?? input.employeeId,
        name: employee ? `${employee.firstName} ${employee.lastName}`.trim() : "Descansos",
        route: BOARD_CHANGE_ROUTES.breakClear,
      }, {
        date: input.date,
        count: 1,
        board: input.board,
      });
    }
    return { cleared: true };
  }, BREAK_TX);
}

/**
 * Deletes this board's break only. A row on the other board stays and is refused.
 * The read commits under the lock. The delete runs only when that same row is still
 * the one on disk, so a save that landed after the read is left in place.
 * A manager clear also requires a live shift on this board.
 */
export async function clearBreak(input: {
  employeeId: string;
  date: string;
  board: "caja" | "cocina";
  actor?: BreakManagerActor;
}): Promise<{ cleared: boolean }> {
  return withBreakLock(() => writeClear(input));
}
