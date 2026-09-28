import type { Prisma } from "@prisma/client";
import { BOARD_CHANGE_ROUTES, writeBoardChange } from "@/lib/board-change-log";
import { BREAK_LOG_ACTOR } from "@/lib/breaks/messages";
import { assessBreak, type BreakShift } from "@/lib/breaks/rules";

async function liveOtherBreaks(
  tx: Prisma.TransactionClient,
  date: string,
  employeeId: string,
): Promise<{ board: string; startAt: Date; endAt: Date }[]> {
  const others = await tx.staffBreak.findMany({
    where: { date, employeeId: { not: employeeId } },
    select: { shiftId: true, board: true, startAt: true, endAt: true },
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
    .map((row) => ({ board: row.board, startAt: row.startAt, endAt: row.endAt }));
}

async function deleteBreakCountsOnly(
  tx: Prisma.TransactionClient,
  row: { id: string; date: string; board: string },
): Promise<void> {
  await tx.staffBreak.delete({ where: { id: row.id } });
  await writeBoardChange(tx, {
    id: BREAK_LOG_ACTOR.id,
    name: BREAK_LOG_ACTOR.name,
    route: BOARD_CHANGE_ROUTES.breakImportDrop,
  }, {
    date: row.date,
    count: 1,
    ...(row.board === "caja" || row.board === "cocina" ? { board: row.board } : {}),
  });
}

/** One counts-only line. A missing break is a no-op. */
export async function dropBreakForShift(tx: Prisma.TransactionClient, shiftId: string): Promise<boolean> {
  const row = await tx.staffBreak.findFirst({ where: { shiftId } });
  if (!row) return false;
  await deleteBreakCountsOnly(tx, row);
  return true;
}

/**
 * Superseded and board-removed shifts lose their break.
 * Then every remaining break for an affected person and date is rechecked,
 * including a break on a shift the import left unchanged. Allowance counts
 * every live caja and cocina shift that day.
 */
export async function dropImportedBreaks(
  tx: Prisma.TransactionClient,
  input: {
    supersededShiftIds: readonly string[];
    changedShiftIds: readonly string[];
    boardRemovedShiftIds: readonly string[];
  },
): Promise<number> {
  const dead = new Set([...input.supersededShiftIds, ...input.boardRemovedShiftIds]);
  let dropped = 0;
  if (dead.size > 0) {
    const rows = await tx.staffBreak.findMany({ where: { shiftId: { in: [...dead] } } });
    for (const row of rows) {
      await deleteBreakCountsOnly(tx, row);
      dropped += 1;
    }
  }

  const affectedIds = [...new Set([...dead, ...input.changedShiftIds])];
  if (affectedIds.length === 0) return dropped;
  const touched = await tx.shift.findMany({
    where: { id: { in: affectedIds } },
    select: { employeeId: true, date: true },
  });
  const pairs = new Map<string, { employeeId: string; date: string }>();
  for (const shift of touched) {
    pairs.set(`${shift.employeeId}\0${shift.date}`, shift);
  }

  for (const { employeeId, date } of pairs.values()) {
    const breaks = await tx.staffBreak.findMany({ where: { employeeId, date } });
    if (breaks.length === 0) continue;
    const shifts = await tx.shift.findMany({ where: { employeeId, date } }) as BreakShift[];
    const others = await liveOtherBreaks(tx, date, employeeId);
    for (const row of breaks) {
      const holder = shifts.find((shift) => shift.id === row.shiftId);
      const inside = Boolean(
        holder
        && !holder.supersededAt
        && !holder.boardRemoved
        && row.startAt.getTime() >= holder.startAt.getTime()
        && row.endAt.getTime() <= holder.endAt.getTime(),
      );
      const decision = assessBreak({
        date: row.date,
        startAt: row.startAt,
        endAt: row.endAt,
        shifts,
        otherBreaks: others,
      });
      if (!inside || "code" in decision) {
        await deleteBreakCountsOnly(tx, row);
        dropped += 1;
      }
    }
  }
  return dropped;
}
