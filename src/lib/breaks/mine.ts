import type { Prisma } from "@prisma/client";
import { approvalPreview } from "@/lib/breaks/preview";
import { breakState } from "@/lib/breaks/status";
import { prisma } from "@/lib/db";
import {
  assessBreak,
  bookedBreaksOnSlice,
  BREAK_BOARD_CEILING,
  breakAllowanceMinutes,
  breakBlackouts,
  clearBreak,
  intervalsOverlap,
  saveBreak,
  scheduledMinutes,
  BreakRefused,
  type BreakShift,
} from "@/lib/breaks/rules";
import { BREAK_REFUSAL_TEXT } from "@/lib/breaks/messages";
import type { StaffSessionClaims } from "@/lib/breaks/session";
import { chicagoDateTime } from "@/lib/time";
import { chicagoToday } from "@/lib/upcoming/source";

export type BreakSlot = { startAt: string; endAt: string };

export type BlockedQuarter = BreakSlot & { reason: "blackout" | "overlap" };

function clockLabel(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "pm" : "am";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function quarterStarts(date: string): Date[] {
  const starts: Date[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 15, 30, 45]) {
      starts.push(chicagoDateTime(date, clockLabel(hour, minute)));
    }
  }
  return starts;
}

function currentOnBoard(shifts: readonly BreakShift[], board: "caja" | "cocina"): BreakShift[] {
  return shifts.filter((shift) => !shift.supersededAt && !shift.boardRemoved && shift.board === board);
}

/** Every 15-minute length assessBreak accepts for this board. */
export function offeredBreakSlots(input: {
  date: string;
  board: "caja" | "cocina";
  shifts: readonly BreakShift[];
  otherBreaks: readonly { board: string; startAt: Date; endAt: Date }[];
}): BreakSlot[] {
  const slots: BreakSlot[] = [];
  for (const start of quarterStarts(input.date)) {
    for (let minutes = 15; minutes <= 90; minutes += 15) {
      const end = new Date(start.getTime() + minutes * 60_000);
      const decision = assessBreak({
        date: input.date,
        startAt: start,
        endAt: end,
        shifts: input.shifts,
        otherBreaks: input.otherBreaks,
      });
      if ("code" in decision || decision.board !== input.board) continue;
      slots.push({ startAt: start.toISOString(), endAt: end.toISOString() });
    }
  }
  return slots;
}

/** Quarters inside this board's shifts that a blackout or another break covers. No names. */
export function blockedBreakQuarters(input: {
  date: string;
  board: "caja" | "cocina";
  shifts: readonly BreakShift[];
  otherBreaks: readonly { board: string; startAt: Date; endAt: Date }[];
}): BlockedQuarter[] {
  const windows = currentOnBoard(input.shifts, input.board);
  const blackouts = breakBlackouts(input.date, input.board);
  const blocked: BlockedQuarter[] = [];
  for (const start of quarterStarts(input.date)) {
    const end = new Date(start.getTime() + 15 * 60_000);
    const inside = windows.some((shift) => start.getTime() >= shift.startAt.getTime() && end.getTime() <= shift.endAt.getTime());
    if (!inside) continue;
    const blackout = blackouts.some((window) => intervalsOverlap(start, end, window.start, window.end));
    const taken = bookedBreaksOnSlice(input.otherBreaks, input.board, start.getTime()) >= BREAK_BOARD_CEILING;
    if (blackout) blocked.push({ startAt: start.toISOString(), endAt: end.toISOString(), reason: "blackout" });
    else if (taken) blocked.push({ startAt: start.toISOString(), endAt: end.toISOString(), reason: "overlap" });
  }
  return blocked;
}

async function liveOtherBreaks(
  tx: Prisma.TransactionClient | typeof prisma,
  date: string,
  employeeId: string,
) {
  const others = await tx.staffBreak.findMany({
    where: { date, employeeId: { not: employeeId } },
    select: { shiftId: true, board: true, startAt: true, endAt: true, status: true },
  });
  if (others.length === 0) return [];
  const live = await tx.shift.findMany({
    where: {
      id: { in: others.map((row) => row.shiftId) },
      supersededAt: null,
      boardRemoved: false,
    },
    select: { id: true },
  });
  const liveIds = new Set(live.map((shift) => shift.id));
  return others
    .filter((row) => liveIds.has(row.shiftId))
    .map((row) => ({ board: row.board, startAt: row.startAt, endAt: row.endAt, status: row.status }));
}

export async function loadMyBreak(claims: StaffSessionClaims, now: Date = new Date()) {
  const date = chicagoToday(now);
  const employee = await prisma.employee.findUnique({
    where: { id: claims.employeeId },
    select: { firstName: true, lastName: true },
  });
  const shifts = await prisma.shift.findMany({
    where: { employeeId: claims.employeeId, date },
  });
  const savedRow = await prisma.staffBreak.findUnique({
    where: { employeeId_date: { employeeId: claims.employeeId, date } },
  });
  const savedLive = savedRow
    ? await prisma.shift.findFirst({
      where: { id: savedRow.shiftId, supersededAt: null, boardRemoved: false },
      select: { id: true },
    })
    : null;
  const otherBreaks = await liveOtherBreaks(prisma, date, claims.employeeId);
  const boards = ["caja", "cocina"] as const;
  const own = shifts.filter(s => !s.supersededAt && !s.boardRemoved && boards.some(b => b === s.board));
  const slots = (await Promise.all(boards.map(async board => {
    const preview = await approvalPreview(date, board, claims.employeeId);
    return offeredBreakSlots({ date, board, shifts, otherBreaks }).flatMap(slot => {
      const approval = preview(new Date(slot.startAt), new Date(slot.endAt));
      return approval ? [{ ...slot, board, approval }] : [];
    });
  }))).flat().sort((a, b) => a.startAt.localeCompare(b.startAt) || a.endAt.localeCompare(b.endAt) || a.board.localeCompare(b.board));
  return {
    name: employee ? `${employee.firstName} ${employee.lastName}`.trim() : "",
    allowanceMinutes: breakAllowanceMinutes(scheduledMinutes(shifts)),
    shifts: own.map((shift) => ({
      id: shift.id,
      board: shift.board,
      startAt: shift.startAt.toISOString(),
      endAt: shift.endAt.toISOString(),
    })),
    blocked: boards.flatMap(board => blockedBreakQuarters({ date, board, shifts, otherBreaks }).map(slot => ({ ...slot, board }))),
    slots,
    saved: savedRow && savedLive
      ? { startAt: savedRow.startAt.toISOString(), endAt: savedRow.endAt.toISOString(), board: savedRow.board,
          status: savedRow.status, state: breakState(savedRow, now), approval: savedRow.status === "ended" ? null : savedRow.status === "pending" || (savedRow.actor !== savedRow.employeeId && !savedRow.auto) ? "gerente" : "automatic" }
      : null,
  };
}

export function breakRefusalText(code: string): string {
  if (["EMPTY_STAR", "STAR_COUNT", "BAD_COVER"].includes(code)) return "Ese horario no está disponible.";
  if (code === "NEEDS_COVER") return "Requiere aprobación del gerente.";
  return BREAK_REFUSAL_TEXT[code] ?? BREAK_REFUSAL_TEXT.LOCK_CONFLICT;
}

export async function saveMyBreak(
  claims: StaffSessionClaims,
  startAt: Date,
  endAt: Date,
  now: Date = new Date(),
) {
  try {
    const date = chicagoToday(now);
    if (chicagoToday(startAt) !== date || chicagoToday(new Date(endAt.getTime() - 1)) !== date) throw new BreakRefused("OUTSIDE_SHIFT");
    const saved = await saveBreak({
      employeeId: claims.employeeId,
      date: chicagoToday(now),
      startAt,
      endAt,
    });
    if (saved.status === "pending") {
      return {
        ok: true as const,
        waiting: true as const,
        message: breakRefusalText("NEEDS_COVER"),
        id: saved.id,
        replaced: saved.replaced,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      };
    }
    return { ok: true as const, waiting: false as const, id: saved.id, replaced: saved.replaced, startAt: startAt.toISOString(), endAt: endAt.toISOString() };
  } catch (error) {
    if (error instanceof BreakRefused) {
      return { ok: false as const, status: 400 as const, error: breakRefusalText(error.code) };
    }
    throw error;
  }
}

export async function clearMyBreak(claims: StaffSessionClaims, now: Date = new Date()) {
  try {
    const result = await clearBreak({
      employeeId: claims.employeeId,
      date: chicagoToday(now),
    });
    return { ok: true as const, cleared: result.cleared };
  } catch (error) {
    if (error instanceof BreakRefused) {
      return { ok: false as const, status: 400 as const, error: breakRefusalText(error.code) };
    }
    throw error;
  }
}
