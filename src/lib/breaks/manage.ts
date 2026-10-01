import { loadBreakPreview } from "@/lib/breaks/preview";
import { breakState } from "@/lib/breaks/status";
import { prisma } from "@/lib/db";
import { describeBreakCover, type ManagerBreakCover } from "@/lib/breaks/cover-positions";
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
import { loadOverlayRecords, toSliceOverlay } from "@/lib/overlays/read";
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
  date?: string;
}) {
  const date = input.date ?? chicagoToday(input.now ?? breaksNow());
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
  const now = input.now ?? breaksNow();
  const preview = await managerPreview(date, input.board, employee.id);
  const slots = offeredBreakSlots({ date, board: input.board, shifts, otherBreaks }).flatMap(slot => {
    const approval = preview.approval(new Date(slot.startAt), new Date(slot.endAt));
    return approval ? [{ ...slot, board: input.board, approval }] : [];
  });
  const covers = row === "this" && savedRow && (savedRow.status === "pending" || savedRow.auto)
    ? preview.covers(savedRow.startAt, savedRow.endAt) : [];
  const pendingRevision = row === "this" && savedRow?.status === "pending"
    ? { id: savedRow.id, updatedAt: savedRow.updatedAt.toISOString() } : null;
  const alternatives = pendingRevision && savedRow && covers.length === 0 && date === chicagoToday(now)
    ? slots.filter(slot => Date.parse(slot.startAt) > now.getTime() && Date.parse(slot.startAt) !== savedRow.startAt.getTime()
      && Date.parse(slot.endAt) - Date.parse(slot.startAt) === savedRow.endAt.getTime() - savedRow.startAt.getTime())
      .flatMap<(typeof slots)[number] & { cover: ManagerBreakCover | null }>(slot => {
        if (slot.approval === "automatic") return [{ ...slot, cover: null }];
        const cover = preview.covers(new Date(slot.startAt), new Date(slot.endAt))[0];
        return cover ? [{ ...slot, cover }] : [];
      }) : [];
  return {
    firstName: employee.firstName,
    allowanceMinutes: breakAllowanceMinutes(scheduledMinutes(shifts)),
    row,
    shifts: currentOnBoard(shifts, input.board).map((shift) => ({
      startAt: shift.startAt.toISOString(),
      endAt: shift.endAt.toISOString(),
    })),
    blocked: blockedBreakQuarters({ date, board: input.board, shifts, otherBreaks }),
    slots,
    stations: preview.stations,
    pendingRevision,
    alternatives,
    approval: savedRow && savedRow.status !== "ended" ? (savedRow.status === "pending" || (savedRow.actor !== savedRow.employeeId && !savedRow.auto) ? "gerente" : "automatic") : null,
    state: savedRow ? breakState(savedRow, input.now ?? breaksNow()) : "absent",
    saved: row === "this" && savedRow && savedRow.status === "booked"
      ? { startAt: savedRow.startAt.toISOString(), endAt: savedRow.endAt.toISOString() }
      : null,
    pending: row === "this" && savedRow && savedRow.status === "pending"
      ? { startAt: savedRow.startAt.toISOString(), endAt: savedRow.endAt.toISOString() }
      : null,
    auto: row === "this" && savedRow?.status === "booked" && savedRow.auto === true,
    covers,
  };
}

/** Load the effective world once for all windows in this manager read. */
async function managerPreview(date: string, board: "caja" | "cocina", employeeId: string) {
  const [preview, otherOverlays, stations] = await Promise.all([
    loadBreakPreview(date, board, employeeId),
    loadOverlayRecords(prisma, board === "caja" ? "cocina" : "caja", date),
    prisma.station.findMany({ select: { id: true, label: true } }),
  ]);
  return { approval: preview.approval, stations,
    covers: (startAt: Date, endAt: Date) => preview.covers(startAt, endAt).map(cover => describeBreakCover(
      { ...preview.context, startAt, endAt }, cover, otherOverlays.map(toSliceOverlay),
    )),
  };
}

/** Manager-only moves from effective slices. The lock rechecks the cover on the tap. */
export async function loadBreakCovers(input: {
  board: "caja" | "cocina"; employeeId: string; date: string; startAt: Date; endAt: Date;
}) {
  return (await managerPreview(input.date, input.board, input.employeeId)).covers(input.startAt, input.endAt);
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
  resolvePending?: { id: string; updatedAt: string };
}) {
  const now = input.now ?? breaksNow();
  if (chicagoToday(input.startAt) !== chicagoToday(now) || chicagoToday(new Date(input.endAt.getTime() - 1)) !== chicagoToday(now)) throw new BreakRefused("NOT_TODAY");
  return saveBreak({
    employeeId: input.employeeId,
    date: chicagoToday(input.now ?? breaksNow()),
    startAt: input.startAt,
    endAt: input.endAt,
    expectedBoard: input.board,
    actor: input.manager,
    authorityNow: input.now ?? breaksNow(),
    coverEmployeeId: input.coverEmployeeId,
    shuffleEmployeeId: input.shuffleEmployeeId,
    resolvePending: input.resolvePending,
  });
}

/** One tap replaces the cover the five-minute pick named. The window stays. */
export async function replaceAutoCover(input: {
  manager: BreakManagerActor;
  board: "caja" | "cocina";
  employeeId: string;
  coverEmployeeId: string;
  shuffleEmployeeId?: string | null;
  now?: Date;
}) {
  const date = chicagoToday(input.now ?? breaksNow());
  const row = await prisma.staffBreak.findUnique({
    where: { employeeId_date: { employeeId: input.employeeId, date } },
  });
  if (!row || row.board !== input.board || row.status !== "booked" || !row.auto) {
    throw new BreakRefused("BAD_COVER");
  }
  return saveManagedBreak({
    manager: input.manager,
    board: input.board,
    employeeId: input.employeeId,
    startAt: row.startAt,
    endAt: row.endAt,
    coverEmployeeId: input.coverEmployeeId,
    shuffleEmployeeId: input.shuffleEmployeeId,
    now: input.now,
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
    authorityNow: input.now ?? breaksNow(),
  });
}
