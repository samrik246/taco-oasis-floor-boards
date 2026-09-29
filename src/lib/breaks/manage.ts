import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { prisma } from "@/lib/db";
import {
  listBreakCovers,
  type BreakCover,
} from "@/lib/breaks/covers";
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
import { isDefaultMandatory, MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import type { SliceBoard, SliceBreak } from "@/lib/slices/day-slices";
import { chicagoToday } from "@/lib/upcoming/source";

export type ManagedBreakRow = "absent" | "this" | "other";

function currentOnBoard(shifts: readonly BreakShift[], board: "caja" | "cocina"): BreakShift[] {
  return shifts.filter((shift) => !shift.supersededAt && !shift.boardRemoved && shift.board === board);
}

async function liveOtherBreaks(date: string, employeeId: string) {
  const others = await prisma.staffBreak.findMany({
    where: { date, employeeId: { not: employeeId } },
    select: { shiftId: true, board: true, startAt: true, endAt: true, status: true },
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
    .map((row) => ({ board: row.board, startAt: row.startAt, endAt: row.endAt, status: row.status }));
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
    saved: row === "this" && savedRow && savedRow.status === "booked"
      ? { startAt: savedRow.startAt.toISOString(), endAt: savedRow.endAt.toISOString() }
      : null,
    pending: row === "this" && savedRow && savedRow.status === "pending"
      ? { startAt: savedRow.startAt.toISOString(), endAt: savedRow.endAt.toISOString() }
      : null,
    covers: row === "this" && savedRow?.status === "pending"
      ? await loadBreakCovers({
        board: input.board,
        employeeId: employee.id,
        date,
        startAt: savedRow.startAt,
        endAt: savedRow.endAt,
      })
      : [],
  };
}

/** The manager list for one window. Names only. The lock rechecks the same list on the tap. */
export async function loadBreakCovers(input: {
  board: "caja" | "cocina";
  employeeId: string;
  date: string;
  startAt: Date;
  endAt: Date;
}): Promise<BreakCover[]> {
  const shifts = await prisma.shift.findMany({
    where: { date: input.date, supersededAt: null, boardRemoved: false },
    include: { employee: { select: { firstName: true } } },
  });
  const shiftIds = shifts.map((shift) => shift.id);
  const paints = shiftIds.length === 0
    ? []
    : await prisma.assignment.findMany({
      where: { shiftId: { in: shiftIds } },
      select: { employeeId: true, shiftId: true, stationId: true, hourStart: true },
    });
  const marks = await prisma.mandatoryMark.findMany({
    where: { board: input.board, date: input.date },
    select: { stationId: true },
  });
  const extra = marks
    .map((mark) => mark.stationId)
    .filter((stationId) => !isDefaultMandatory(stationId));
  const breakRows = await prisma.staffBreak.findMany({
    where: { date: input.date },
    select: {
      employeeId: true,
      shiftId: true,
      board: true,
      startAt: true,
      endAt: true,
      status: true,
      coverEmployeeId: true,
      shuffleEmployeeId: true,
    },
  });
  const abilities = await prisma.employeeStationAbility.findMany({
    where: { employeeId: { in: shifts.map((shift) => shift.employeeId) } },
    select: { employeeId: true, stationId: true, level: true },
  });
  const defaults = await loadColumnDefaults();
  const breaks: SliceBreak[] = breakRows.flatMap((row) => {
    if (row.status !== "booked" && row.status !== "pending") return [];
    if (row.board !== "caja" && row.board !== "cocina") return [];
    return [{
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      board: row.board,
      startAt: row.startAt,
      endAt: row.endAt,
      status: row.status,
      coverEmployeeId: row.coverEmployeeId,
      shuffleEmployeeId: row.shuffleEmployeeId,
    }];
  });
  return listBreakCovers({
    date: input.date,
    board: input.board as SliceBoard,
    employeeId: input.employeeId,
    startAt: input.startAt,
    endAt: input.endAt,
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
      }];
    }),
    breaks,
    starStationIds: [...MANDATORY_STATIONS_BY_BOARD[input.board], ...extra],
    abilities,
    defaults,
    names: new Map(shifts.map((shift) => [shift.employeeId, shift.employee.firstName])),
  });
}

export async function saveManagedBreak(input: {
  manager: BreakManagerActor;
  board: "caja" | "cocina";
  employeeId: string;
  startAt: Date;
  endAt: Date;
  coverEmployeeId?: string | null;
  shuffleEmployeeId?: string | null;
  now?: Date;
}) {
  return saveBreak({
    employeeId: input.employeeId,
    date: chicagoToday(input.now ?? breaksNow()),
    startAt: input.startAt,
    endAt: input.endAt,
    expectedBoard: input.board,
    actor: input.manager,
    coverEmployeeId: input.coverEmployeeId,
    shuffleEmployeeId: input.shuffleEmployeeId,
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
