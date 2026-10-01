import { quarterState } from "@/lib/quarter/schema";
import { decisionPaints } from "@/lib/quarter/decision-paint";
import { chicagoToday } from "@/lib/upcoming/source";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import type { Prisma } from "@prisma/client";
import { gerenteAuthority } from "@/lib/breaks/authority";
import { prisma } from "@/lib/db";
import { BOARD_CHANGE_ROUTES, writeBoardChange } from "@/lib/board-change-log";
import { TIMEZONE } from "@/lib/constants";
import { chicagoDateOffset } from "@/lib/date-math";
import { isDefaultMandatory, MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { numberedSeatCover, listBreakCovers, listedCover, type BreakCover } from "@/lib/breaks/covers";
import { assessStarGate, readBreakGate } from "@/lib/slices/break-gate";
import type { SliceBoard, SliceBreak, SliceOverlay, SlicePaint, SliceShift } from "@/lib/slices/day-slices";
import { loadOverlayRecords, toSliceOverlay } from "@/lib/overlays/read";
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

/** Two booked breaks may cover one quarter. A third is refused. Pending is not booked. */
export const BREAK_BOARD_CEILING = 2;
const SLICE_MS = 15 * MINUTE_MS;

export function breakSliceStarts(start: Date, end: Date): number[] {
  const starts: number[] = [];
  for (let at = start.getTime(); at + SLICE_MS <= end.getTime(); at += SLICE_MS) starts.push(at);
  return starts;
}

export function bookedBreaksOnSlice(
  others: readonly { board: string; startAt: Date; endAt: Date; status?: string }[],
  board: string,
  sliceStart: number,
): number {
  const sliceEnd = sliceStart + SLICE_MS;
  return others.filter((other) => {
    if (other.board !== board || (other.status != null && other.status !== "booked")) return false;
    return sliceStart >= other.startAt.getTime() && sliceEnd <= other.endAt.getTime();
  }).length;
}

/**
 * Placement, allowance, blackout, and at most two booked breaks on the board.
 * Blackout windows come only from breakBlackouts.
 */
export function assessBreak(input: {
  date: string;
  startAt: Date;
  endAt: Date;
  shifts: readonly BreakShift[];
  otherBreaks: readonly { board: string; startAt: Date; endAt: Date; status?: string }[];
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
  if (new Set(containers.filter(s => s.board === "caja" || s.board === "cocina").map(s => s.board)).size > 1) return { code: "BOARD_MISMATCH" };
  const held = containers.find((shift) => shift.board === "caja" || shift.board === "cocina");
  if (!held) {
    return { code: containers.some((shift) => shift.board === "other") ? "OTHER_BOARD" : "OUTSIDE_SHIFT" };
  }
  const allowance = breakAllowanceMinutes(scheduledMinutes(input.shifts));
  if (duration > allowance) return { code: "ALLOWANCE" };
  for (const window of breakBlackouts(input.date, held.board)) {
    if (intervalsOverlap(input.startAt, input.endAt, window.start, window.end)) return { code: "BLACKOUT" };
  }
  for (const sliceStart of breakSliceStarts(input.startAt, input.endAt)) {
    if (bookedBreaksOnSlice(input.otherBreaks, held.board, sliceStart) >= BREAK_BOARD_CEILING) {
      return { code: "CEILING" };
    }
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
  actor: string;
  updatedAtMs: number;
  startAtMs: number;
  endAtMs: number;
};

/** Strictly newer than the row it replaces, including a same-slot save in the same millisecond. */
export function nextBreakWriteStamp(previousMs: number | null, nowMs = Date.now()): Date {
  if (previousMs == null) return new Date(nowMs);
  return new Date(Math.max(nowMs, previousMs + 1));
}

/**
 * Test seam. The clear commits its read, then this runs, then it deletes only
 * if that same row is still there. The mini has no test root, so this stays unset.
 */
let afterClearRead: ((snapshot: ClearRead | null) => Promise<void>) | null = null;
let breakLockBusyRemaining = 0;

export function setAfterClearReadForTests(
  probe: ((snapshot: ClearRead | null) => Promise<void>) | null,
): void {
  if (!process.env.FLOOR_BOARDS_TEST_ROOT) {
    throw new Error("break read probe requires the test root");
  }
  afterClearRead = probe;
}

/** Each count throws one busy error inside the lock retry, then the real write runs. */
export function setBreakLockBusyForTests(count: number): void {
  if (!process.env.FLOOR_BOARDS_TEST_ROOT) {
    throw new Error("break lock fault requires the test root");
  }
  breakLockBusyRemaining = count;
}

async function liveBreaks(
  tx: Prisma.TransactionClient,
  rows: readonly { id?: string; shiftId: string; board: string; startAt: Date; endAt: Date; status?: string }[],
): Promise<{ board: string; startAt: Date; endAt: Date; status?: string }[]> {
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
    .map((row) => ({ board: row.board, startAt: row.startAt, endAt: row.endAt, status: row.status }));
}

export async function starWorld(
  tx: Prisma.TransactionClient,
  date: string,
  board: "caja" | "cocina",
): Promise<{ canonical:boolean; shifts: SliceShift[]; paints: SlicePaint[]; breaks: SliceBreak[]; starStationIds: string[]; overlays: SliceOverlay[] }> {
  const shifts = await tx.shift.findMany({
    where: { date, supersededAt: null, boardRemoved: false },
  });
  const paints = await decisionPaints(tx, date);
  const canonical = (await quarterState(tx))?.phase === "active";
  const marks = await tx.mandatoryMark.findMany({
    where: { board, date },
    select: { stationId: true },
  });
  const extra = marks
    .map((mark) => mark.stationId)
    .filter((stationId) => !isDefaultMandatory(stationId));
  const breaks = await tx.staffBreak.findMany({
    where: { date },
    select: {
      employeeId: true,
      shiftId: true,
      board: true,
      startAt: true,
      endAt: true,
      status: true,
      coverEmployeeId: true,
      coverShiftId: true,
      shuffleShiftId: true,
      shuffleEmployeeId: true,
      auto: true,
    },
  });
  const overlays = (await loadOverlayRecords(tx, canonical?null:board, date)).map(row=>({...toSliceOverlay(row),...(canonical?{board:row.board}:{})}));
  return {
    canonical,
    shifts: shifts.map((shift) => ({
      id: shift.id,
      employeeId: shift.employeeId,
      board: shift.board,
      startAt: shift.startAt,
      endAt: shift.endAt,
      superseded: false,
      boardRemoved: false,
    })),
    paints: paints.flatMap((row) => {
      if (!row.employeeId) return [];
      return [{
        employeeId: row.employeeId,
        shiftId: row.shiftId,
        stationId: row.stationId,
        hourStart: row.hourStart,
        ...(row.intervalEnd ? { intervalEnd: row.intervalEnd } : {}),
      }];
    }),
    breaks: breaks.flatMap((row) => {
      if (row.status !== "booked" && row.status !== "pending") return [];
      const status = row.status;
      return [{
        employeeId: row.employeeId,
        shiftId: row.shiftId,
        board: row.board,
        startAt: row.startAt,
        endAt: row.endAt,
        status,
        coverEmployeeId: row.coverEmployeeId,
        ...(canonical ? { coverShiftId: row.coverShiftId, shuffleShiftId: row.shuffleShiftId } : {}),
        shuffleEmployeeId: row.shuffleEmployeeId,
        auto: row.auto,
      }];
    }),
    starStationIds: [...MANDATORY_STATIONS_BY_BOARD[board], ...extra],
    overlays,
  };
}

async function withBreakLock<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= BREAK_LOCK_ATTEMPTS; attempt += 1) {
    try {
      if (breakLockBusyRemaining > 0) {
        breakLockBusyRemaining -= 1;
        throw new Error("SQLITE_BUSY: database is locked");
      }
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

/** The lock row, then one write. A second caller waits, then sees the first write. */
export async function withStaffBreakLock<T>(
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withBreakLock(() => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.staffBreakLock.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { updatedAt: new Date() },
    });
    return write(tx);
  }, BREAK_TX));
}

async function writeBreak(
  input: {
    employeeId: string;
    date: string;
    startAt: Date;
    endAt: Date;
    expectedBoard?: "caja" | "cocina";
    actor?: BreakManagerActor;
    authorityNow?: Date;
    resolvePending?: { id: string; updatedAt: string };
    coverEmployeeId?: string | null;
    shuffleEmployeeId?: string | null;
  },
): Promise<{ id: string; replaced: boolean; status: "booked" | "pending"; covers: BreakCover[] }> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.staffBreakLock.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { updatedAt: new Date() },
    });
    if (input.authorityNow && input.actor && !await gerenteAuthority(input.actor.id, input.authorityNow, tx)) throw new BreakRefused("GERENTE_REQUIRED");
    const employee = await tx.employee.findUnique({
      where: { id: input.employeeId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!employee) throw new BreakRefused("NOT_FOUND");
    const shifts = await tx.shift.findMany({ where: { employeeId: input.employeeId, date: input.date } });
    const gate = readBreakGate({
      date: input.date,
      employeeId: input.employeeId,
      startAt: input.startAt,
      endAt: input.endAt,
      shifts: shifts.map((shift) => ({
        id: shift.id,
        employeeId: shift.employeeId,
        board: shift.board,
        startAt: shift.startAt,
        endAt: shift.endAt,
        superseded: shift.supersededAt != null,
        boardRemoved: shift.boardRemoved,
      })),
    });
    const others = await tx.staffBreak.findMany({
      where: { date: input.date, employeeId: { not: input.employeeId } },
      select: { shiftId: true, board: true, startAt: true, endAt: true, status: true },
    });
    const decision = assessBreak({
      date: input.date,
      startAt: input.startAt,
      endAt: input.endAt,
      shifts,
      otherBreaks: await liveBreaks(tx, others),
    });
    if ("code" in decision) throw new BreakRefused(decision.code);
    if (!gate.everyTouchedSliceInsideShift) throw new BreakRefused("OUTSIDE_SHIFT");
    if (input.expectedBoard && decision.board !== input.expectedBoard) {
      throw new BreakRefused("BOARD_MISMATCH");
    }
    const world = await starWorld(tx, input.date, decision.board as SliceBoard);
    if (world.breaks.some(row => row.status === "booked" && row.employeeId !== input.employeeId
      && row.startAt < input.endAt && row.endAt > input.startAt
      && (row.coverEmployeeId === input.employeeId || row.shuffleEmployeeId === input.employeeId))) throw new BreakRefused("BAD_COVER");
    const namedIds = [...new Set(world.shifts.map((shift) => shift.employeeId))];
    const [abilityRows, nameRows, defaults] = await Promise.all([
      tx.employeeStationAbility.findMany({
        where: { employeeId: { in: namedIds } },
        select: { employeeId: true, stationId: true, level: true },
      }),
      tx.employee.findMany({
        where: { id: { in: namedIds } },
        select: { id: true, firstName: true },
      }),
      loadColumnDefaults(tx),
    ]);
    const coverInput = {
      canonical:world.canonical,requesterShiftId:decision.shiftId,
      date: input.date,
      board: decision.board as SliceBoard,
      employeeId: input.employeeId,
      startAt: input.startAt,
      endAt: input.endAt,
      shifts: world.shifts,
      paints: world.paints,
      breaks: world.breaks,
      starStationIds: world.starStationIds,
      overlays: world.overlays,
      abilities: abilityRows,
      defaults,
      names: new Map(nameRows.map((person) => [person.id, person.firstName])),
    };
    const covers = listBreakCovers(coverInput);
    const numbered = !input.coverEmployeeId && !input.shuffleEmployeeId ? numberedSeatCover(coverInput) : null;
    const requestedCover = input.coverEmployeeId ?? numbered?.employeeId ?? null;
    const requestedShuffle = input.shuffleEmployeeId ?? null;
    if (requestedCover || requestedShuffle) {
      if (!requestedCover || !listedCover(covers, requestedCover, requestedShuffle)) {
        throw new BreakRefused("BAD_COVER");
      }
    }
    const selectedCover=requestedCover?listedCover(covers,requestedCover,requestedShuffle):null;
    const star = assessStarGate({
      canonical:world.canonical,requesterShiftId:decision.shiftId,
      coverShiftId:selectedCover?.kind==="simple"?selectedCover.shiftId:selectedCover?.moves[0].shiftId,
      shuffleShiftId:selectedCover?.kind==="shuffle"?selectedCover.moves[1].shiftId:null,
      date: input.date,
      board: decision.board as SliceBoard,
      employeeId: input.employeeId,
      startAt: input.startAt,
      endAt: input.endAt,
      shifts: world.shifts,
      paints: world.paints,
      breaks: world.breaks,
      starStationIds: world.starStationIds,
      overlays: world.overlays,
      coverEmployeeId: requestedCover,
      shuffleEmployeeId: requestedShuffle,
    });
    let status: "booked" | "pending" = "booked";
    let coverEmployeeId: string | null = null;
    let coverShiftId: string | null = null;
    let shuffleEmployeeId: string | null = null;
    let shuffleShiftId: string | null = null;
    if ("code" in star) {
      if (requestedCover) throw new BreakRefused(star.code === "NEEDS_COVER" ? "BAD_COVER" : star.code);
      if (star.code !== "NEEDS_COVER") throw new BreakRefused(star.code);
      status = "pending";
    } else {
      coverEmployeeId = star.coverEmployeeId;
      coverShiftId = star.coverShiftId;
      shuffleEmployeeId = star.shuffleEmployeeId;
      shuffleShiftId = star.shuffleShiftId;
    }
    const existing = await tx.staffBreak.findUnique({
      where: { employeeId_date: { employeeId: input.employeeId, date: input.date } },
      select: { id: true, board: true, updatedAt: true, status: true, startAt: true, endAt: true },
    });
    if (input.expectedBoard && existing && existing.board !== input.expectedBoard) {
      throw new BreakRefused("BOARD_MISMATCH");
    }
    if (input.resolvePending) {
      if (input.actor?.kind !== "manager" || !input.authorityNow) throw new BreakRefused("GERENTE_REQUIRED");
      if (!existing || existing.status !== "pending" || existing.id !== input.resolvePending.id
        || existing.updatedAt.toISOString() !== input.resolvePending.updatedAt) throw new BreakRefused("LOCK_CONFLICT");
      if (existing.board !== decision.board) throw new BreakRefused("BOARD_MISMATCH");
      if (input.date !== chicagoToday(input.authorityNow) || input.startAt <= input.authorityNow || chicagoToday(input.startAt) !== input.date
        || chicagoToday(new Date(input.endAt.getTime() - 1)) !== input.date) throw new BreakRefused("NOT_TODAY");
      if (input.endAt.getTime() - input.startAt.getTime() !== existing.endAt.getTime() - existing.startAt.getTime()) throw new BreakRefused("ALLOWANCE");
      if (status !== "booked") throw new BreakRefused("NEEDS_COVER");
    }
    const manager = input.actor?.kind === "manager" ? input.actor : null;
    const actorId = manager ? manager.id : employee.id;
    const updatedAt = nextBreakWriteStamp(existing?.updatedAt.getTime() ?? null);
    const saved = existing
      ? await tx.staffBreak.update({
        where: { id: existing.id },
        data: {
          shiftId: decision.shiftId,
          board: decision.board,
          startAt: input.startAt,
          endAt: input.endAt,
          actor: actorId,
          status,
          coverEmployeeId,
          coverShiftId,
          shuffleEmployeeId,
          shuffleShiftId,
          auto: false,
          updatedAt,
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
          status,
          coverEmployeeId,
          coverShiftId,
          shuffleEmployeeId,
          shuffleShiftId,
          auto: false,
          updatedAt,
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
    return { id: saved.id, replaced: existing != null, status, covers: status === "pending" ? covers : [] };
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
  authorityNow?: Date;
  resolvePending?: { id: string; updatedAt: string };
  /** Named by the manager. Absent, a star seat waits. */
  coverEmployeeId?: string | null;
  /** Second Shuffle move. Present only with the star-seat person who moves over. */
  shuffleEmployeeId?: string | null;
}): Promise<{ id: string; replaced: boolean; status: "booked" | "pending"; covers: BreakCover[] }> {
  return withBreakLock(() => writeBreak(input));
}

function sameClearRead(
  existing: { id: string; actor: string; updatedAt: Date; startAt: Date; endAt: Date },
  snapshot: ClearRead,
): boolean {
  return existing.id === snapshot.id
    && existing.actor === snapshot.actor
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
      select: { id: true, actor: true, updatedAt: true, startAt: true, endAt: true },
    });
    if (!existing) return null;
    return {
      id: existing.id,
      actor: existing.actor,
      updatedAtMs: existing.updatedAt.getTime(),
      startAtMs: existing.startAt.getTime(),
      endAtMs: existing.endAt.getTime(),
    };
  }, BREAK_TX);
}

async function writeClear(input: {
  employeeId: string;
  date: string;
  board?: "caja" | "cocina";
  actor?: BreakManagerActor;
  authorityNow?: Date;
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
    if (input.authorityNow && manager && !await gerenteAuthority(manager.id, input.authorityNow, tx)) throw new BreakRefused("GERENTE_REQUIRED");
    if (manager) {
      if (input.board && existing && existing.board !== input.board) throw new BreakRefused("BOARD_MISMATCH");
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
      if (input.board && existing.board !== input.board) throw new BreakRefused("BOARD_MISMATCH");
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
        board: (input.board ?? existing.board) as "caja" | "cocina",
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
        board: (input.board ?? existing.board) as "caja" | "cocina",
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
  board?: "caja" | "cocina";
  actor?: BreakManagerActor;
  authorityNow?: Date;
}): Promise<{ cleared: boolean }> {
  return withBreakLock(() => writeClear(input));
}
