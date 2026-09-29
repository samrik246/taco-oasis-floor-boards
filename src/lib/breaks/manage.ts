import { prisma } from "@/lib/db";
import {
  blockedBreakQuarters,
  offeredBreakSlots,
} from "@/lib/breaks/mine";
import { breaksNow } from "@/lib/breaks/now";
import {
  BreakRefused,
  breakAllowanceMinutes,
  clearBreak,
  saveBreak,
  scheduledMinutes,
  type BreakManagerActor,
  type BreakShift,
} from "@/lib/breaks/rules";
import { chicagoToday } from "@/lib/upcoming/source";

export type ManagedBreakRow = "absent" | "this" | "other";

function currentOnBoard(shifts: readonly BreakShift[], board: "caja" | "cocina"): BreakShift[] {
  return shifts.filter((shift) => !shift.supersededAt && !shift.boardRemoved && shift.board === board);
}

async function liveOtherBreaks(date: string, employeeId: string) {
  const others = await prisma.staffBreak.findMany({
    where: { date, employeeId: { not: employeeId } },
    select: { shiftId: true, board: true, startAt: true, endAt: true },
  });
  if (others.length === 0) return [];
  const live = await prisma.shift.findMany({
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
    .map((row) => ({ board: row.board, startAt: row.startAt, endAt: row.endAt }));
}

/** Allowance uses every shift today. The windows are the requested board only. */
export async function loadManagedBreak(input: {
  board: "caja" | "cocina";
  employeeId: string;
  now?: Date;
}) {
  const date = chicagoToday(input.now ?? breaksNow());
  const employee = await prisma.employee.findUnique({
    where: { id: input.employeeId },
    select: { id: true, firstName: true },
  });
  if (!employee) throw new BreakRefused("NOT_FOUND");
  const shifts = await prisma.shift.findMany({
    where: { employeeId: employee.id, date },
  });
  const savedRow = await prisma.staffBreak.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date } },
  });
  const otherBreaks = await liveOtherBreaks(date, employee.id);
  const row: ManagedBreakRow = !savedRow ? "absent" : savedRow.board === input.board ? "this" : "other";
  return {
    firstName: employee.firstName,
    allowanceMinutes: breakAllowanceMinutes(scheduledMinutes(shifts)),
    row,
    shifts: currentOnBoard(shifts, input.board).map((shift) => ({
      startAt: shift.startAt.toISOString(),
      endAt: shift.endAt.toISOString(),
    })),
    blocked: blockedBreakQuarters({ date, board: input.board, shifts, otherBreaks }),
    slots: offeredBreakSlots({ date, board: input.board, shifts, otherBreaks }),
    saved: row === "this" && savedRow
      ? { startAt: savedRow.startAt.toISOString(), endAt: savedRow.endAt.toISOString() }
      : null,
  };
}

export async function saveManagedBreak(input: {
  manager: BreakManagerActor;
  board: "caja" | "cocina";
  employeeId: string;
  startAt: Date;
  endAt: Date;
  now?: Date;
}) {
  return saveBreak({
    employeeId: input.employeeId,
    date: chicagoToday(input.now ?? breaksNow()),
    startAt: input.startAt,
    endAt: input.endAt,
    expectedBoard: input.board,
    actor: input.manager,
  });
}

export async function clearManagedBreak(input: {
  manager: BreakManagerActor;
  board: "caja" | "cocina";
  employeeId: string;
  now?: Date;
}) {
  return clearBreak({
    employeeId: input.employeeId,
    date: chicagoToday(input.now ?? breaksNow()),
    board: input.board,
    actor: input.manager,
  });
}
