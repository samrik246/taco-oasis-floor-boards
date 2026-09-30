import type { Prisma } from "@prisma/client";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { firstAutoCover } from "@/lib/breaks/covers";
import {
  findHandoffOverlay,
  overlayCoversWindow,
  paintStationAt,
} from "@/lib/breaks/handoff-cover";
import { breaksNow } from "@/lib/breaks/now";
import {
  assessBreak,
  nextBreakWriteStamp,
  withStaffBreakLock,
} from "@/lib/breaks/rules";
import { isDefaultMandatory, MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { loadOverlayRecords, toSliceOverlay } from "@/lib/overlays/read";
import { assessStarGate } from "@/lib/slices/break-gate";
import type { SliceBoard, SliceBreak, SliceOverlay, SliceShift } from "@/lib/slices/day-slices";

/** Five minutes before the window. A later read does not pick. */
export const BREAK_PICK_LEAD_MS = 5 * 60 * 1000;

/** One wake. The lock, not this timer, decides the pick. */
export const BREAK_PICK_EVERY_MS = 30_000;

const SLICE_MS = 15 * 60 * 1000;

export type BreakPickTally = { picked: number; rolled: number; ended: number };

export type DueBreakRead = { id: string; startAtMs: number };

/**
 * Test seam. The first read commits, then this runs, then the conditional
 * write runs only if that same pending window is still the one on disk.
 * The mini has no test root, so this stays unset.
 */
let afterPickRead: ((rows: readonly DueBreakRead[]) => Promise<void>) | null = null;

export function setAfterPickReadForTests(
  probe: ((rows: readonly DueBreakRead[]) => Promise<void>) | null,
): void {
  if (!process.env.FLOOR_BOARDS_TEST_ROOT) {
    throw new Error("break pick probe requires the test root");
  }
  afterPickRead = probe;
}

function asBoard(board: string): SliceBoard | null {
  return board === "caja" || board === "cocina" ? board : null;
}

function isDue(start: Date, now: Date): boolean {
  const lead = start.getTime() - now.getTime();
  return lead > 0 && lead <= BREAK_PICK_LEAD_MS;
}

type PendingRow = {
  id: string;
  employeeId: string;
  shiftId: string;
  date: string;
  board: string;
  startAt: Date;
  endAt: Date;
  updatedAt: Date;
  status: string;
  coverEmployeeId: string | null;
  coverShiftId: string | null;
};

type PickWorld = Awaited<ReturnType<typeof loadPickWorld>>;

async function loadPickWorld(
  tx: Prisma.TransactionClient,
  date: string,
  board: SliceBoard,
) {
  const shifts = await tx.shift.findMany({
    where: { date, supersededAt: null, boardRemoved: false },
    include: { employee: { select: { firstName: true } } },
  });
  const shiftIds = shifts.map((shift) => shift.id);
  const paints = shiftIds.length === 0
    ? []
    : await tx.assignment.findMany({
      where: { shiftId: { in: shiftIds } },
      select: { employeeId: true, shiftId: true, stationId: true, hourStart: true },
    });
  const marks = await tx.mandatoryMark.findMany({
    where: { board, date },
    select: { stationId: true },
  });
  const extra = marks
    .map((mark) => mark.stationId)
    .filter((stationId) => !isDefaultMandatory(stationId));
  const breakRows = await tx.staffBreak.findMany({
    where: { date },
    select: {
      employeeId: true,
      shiftId: true,
      board: true,
      startAt: true,
      endAt: true,
      status: true,
      coverEmployeeId: true,
      shuffleEmployeeId: true,
      auto: true,
    },
  });
  const abilities = await tx.employeeStationAbility.findMany({
    where: { employeeId: { in: shifts.map((shift) => shift.employeeId) } },
    select: { employeeId: true, stationId: true, level: true },
  });
  const defaults = await loadColumnDefaults(tx);
  const breaks: SliceBreak[] = breakRows.flatMap((row) => {
    if (row.status !== "booked" && row.status !== "pending") return [];
    if (row.board !== "caja" && row.board !== "cocina") return [];
    const status = row.status;
    return [{
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      board: row.board,
      startAt: row.startAt,
      endAt: row.endAt,
      status,
      coverEmployeeId: row.coverEmployeeId,
      shuffleEmployeeId: row.shuffleEmployeeId,
      auto: row.auto,
    }];
  });
  return {
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
    starStationIds: [...MANDATORY_STATIONS_BY_BOARD[board], ...extra],
    abilities,
    defaults,
    names: new Map(shifts.map((shift) => [shift.employeeId, shift.employee.firstName])),
    overlays: (await loadOverlayRecords(tx, board, date)).map(toSliceOverlay),
  };
}

async function assessHeldWindow(
  tx: Prisma.TransactionClient,
  row: PendingRow,
  startAt: Date,
  endAt: Date,
) {
  const shifts = await tx.shift.findMany({
    where: { employeeId: row.employeeId, date: row.date },
  });
  const others = await tx.staffBreak.findMany({
    where: { date: row.date, employeeId: { not: row.employeeId } },
    select: { shiftId: true, board: true, startAt: true, endAt: true, status: true },
  });
  const live = others.length === 0
    ? []
    : await tx.shift.findMany({
      where: {
        id: { in: others.map((other) => other.shiftId) },
        supersededAt: null,
        boardRemoved: false,
      },
      select: { id: true },
    });
  const liveIds = new Set(live.map((shift) => shift.id));
  return assessBreak({
    date: row.date,
    startAt,
    endAt,
    shifts,
    otherBreaks: others
      .filter((other) => liveIds.has(other.shiftId))
      .map((other) => ({
        board: other.board,
        startAt: other.startAt,
        endAt: other.endAt,
        status: other.status,
      })),
  });
}

async function rolledWindowFits(
  tx: Prisma.TransactionClient,
  row: PendingRow,
  startAt: Date,
  endAt: Date,
): Promise<boolean> {
  const decision = await assessHeldWindow(tx, row, startAt, endAt);
  if (!("code" in decision)) return true;
  return decision.code === "CEILING";
}

function shiftCovering(
  shifts: readonly SliceShift[],
  employeeId: string,
  start: Date,
  end: Date,
  board: string,
): SliceShift | null {
  return shifts.find((shift) => {
    return shift.employeeId === employeeId
      && shift.board === board
      && !shift.superseded
      && !shift.boardRemoved
      && start.getTime() >= shift.startAt.getTime()
      && end.getTime() <= shift.endAt.getTime();
  }) ?? null;
}

/** The switch or add that seated this name on the breaker's star, if there is one. */
function bindingOverlay(row: PendingRow, world: PickWorld): SliceOverlay | null {
  if (!row.coverEmployeeId) return null;
  const seat = paintStationAt(world.paints, row.employeeId, row.shiftId, row.startAt);
  return findHandoffOverlay(world.overlays, row.coverEmployeeId, seat, world.starStationIds);
}

/**
 * The named cover ranks first when the handoff overlay still covers this
 * window and the star gate accepts them with that overlay left out.
 * No handoff overlay keeps the shift-and-gate check. A window the overlay
 * does not cover drops the name.
 */
function namedCoverFirst(
  row: PendingRow,
  board: SliceBoard,
  world: PickWorld,
  startAt: Date,
  endAt: Date,
): { employeeId: string; shiftId: string } | null {
  if (!row.coverEmployeeId) return null;
  const handoff = bindingOverlay(row, world);
  if (handoff && !overlayCoversWindow(handoff, startAt, endAt)) return null;
  const shift = shiftCovering(world.shifts, row.coverEmployeeId, startAt, endAt, board);
  if (!shift) return null;
  const star = assessStarGate({
    date: row.date,
    board,
    employeeId: row.employeeId,
    startAt,
    endAt,
    shifts: world.shifts,
    paints: world.paints,
    breaks: world.breaks,
    starStationIds: world.starStationIds,
    overlays: handoff ? world.overlays.filter((overlay) => overlay.id !== handoff.id) : world.overlays,
    coverEmployeeId: row.coverEmployeeId,
  });
  if ("code" in star) return null;
  return { employeeId: row.coverEmployeeId, shiftId: shift.id };
}

async function readDue(tx: Prisma.TransactionClient, now: Date): Promise<DueBreakRead[]> {
  const rows = await tx.staffBreak.findMany({
    where: { status: "pending" },
    select: { id: true, startAt: true },
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
  });
  return rows
    .filter((row) => isDue(row.startAt, now))
    .map((row) => ({ id: row.id, startAtMs: row.startAt.getTime() }));
}

async function applyDue(tx: Prisma.TransactionClient, now: Date): Promise<BreakPickTally> {
  const queue = await tx.staffBreak.findMany({
    where: { status: "pending" },
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
  });
  const tally: BreakPickTally = { picked: 0, rolled: 0, ended: 0 };
  for (const queued of queue) {
    const current = await tx.staffBreak.findUnique({ where: { id: queued.id } });
    if (!current || current.status !== "pending") continue;
    if (!isDue(current.startAt, now)) continue;
    const board = asBoard(current.board);
    if (!board) continue;
    const row: PendingRow = current;
    const world = await loadPickWorld(tx, row.date, board);
    const named = namedCoverFirst(row, board, world, row.startAt, row.endAt);
    const ordinary = named ? null : firstAutoCover({
      date: row.date,
      board,
      employeeId: row.employeeId,
      startAt: row.startAt,
      endAt: row.endAt,
      ...world,
    });
    const choice = named ?? ordinary;
    const held = await assessHeldWindow(tx, row, row.startAt, row.endAt);
    const ceilingFull = "code" in held && held.code === "CEILING";
    const updatedAt = nextBreakWriteStamp(row.updatedAt.getTime());
    if (choice && !ceilingFull) {
      const wrote = await tx.staffBreak.updateMany({
        where: {
          id: row.id,
          status: "pending",
          startAt: row.startAt,
          coverEmployeeId: row.coverEmployeeId,
        },
        data: {
          status: "booked",
          coverEmployeeId: choice.employeeId,
          coverShiftId: choice.shiftId,
          shuffleEmployeeId: null,
          shuffleShiftId: null,
          auto: named == null,
          updatedAt,
        },
      });
      if (wrote.count === 1) tally.picked += 1;
      continue;
    }
    const nextStart = new Date(row.startAt.getTime() + SLICE_MS);
    const nextEnd = new Date(row.endAt.getTime() + SLICE_MS);
    const fits = await rolledWindowFits(tx, row, nextStart, nextEnd);
    const nextNamed = namedCoverFirst(row, board, world, nextStart, nextEnd);
    const wrote = await tx.staffBreak.updateMany({
      where: {
        id: row.id,
        status: "pending",
        startAt: row.startAt,
        coverEmployeeId: row.coverEmployeeId,
      },
      data: fits
        ? {
          startAt: nextStart,
          endAt: nextEnd,
          auto: false,
          updatedAt,
          ...(nextNamed
            ? { coverShiftId: nextNamed.shiftId }
            : { coverEmployeeId: null, coverShiftId: null, shuffleEmployeeId: null, shuffleShiftId: null }),
        }
        : { status: "ended", auto: false, updatedAt },
    });
    if (wrote.count !== 1) continue;
    if (fits) tally.rolled += 1;
    else tally.ended += 1;
  }
  return tally;
}

/**
 * Pending breaks due in the next five minutes, earliest first.
 * A row that already names a cover stays in this queue. That person ranks
 * first when their shift still covers the window and the star gate accepts
 * them. A name that came from a handoff overlay is kept only while that
 * overlay covers the window, and the star gate runs with the overlay left
 * out. Any other window clears the name and the ordinary pick decides.
 * One conditional write inside the lock books when that quarter still has a
 * booked spot. A full ceiling rolls the same length one quarter, or ends
 * the break when the next quarter no longer fits. A window already under
 * way is left as it was. Two callers cannot both win the same row.
 */
export async function pickDueCovers(now: Date = breaksNow()): Promise<BreakPickTally> {
  const seen = await withStaffBreakLock((tx) => readDue(tx, now));
  if (afterPickRead) await afterPickRead(seen);
  return withStaffBreakLock((tx) => applyDue(tx, now));
}

const pickState = globalThis as { __floorBoardsBreakPick?: boolean };

/** One timer in the Node server. Tests and the edge runtime do not start it. */
export function startBreakPickTimer(): void {
  if (process.env.FLOOR_BOARDS_TEST_ROOT) return;
  if (pickState.__floorBoardsBreakPick) return;
  pickState.__floorBoardsBreakPick = true;
  setInterval(() => {
    void pickDueCovers().catch(() => undefined);
  }, BREAK_PICK_EVERY_MS);
}
