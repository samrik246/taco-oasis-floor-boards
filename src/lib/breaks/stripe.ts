import { prisma } from "@/lib/db";
import { breakStripeLabel, type BreakStripe } from "@/lib/breaks/stripe-label";

export type { BreakStripe };
export { breakStripeLabel };

/** Live shifts only. A superseded or board-removed shift contributes nothing. */
export async function boardBreakStripes(board: string, date: string): Promise<BreakStripe[]> {
  const rows = await prisma.staffBreak.findMany({
    where: { board, date, status: "booked" },
    select: {
      employeeId: true,
      shiftId: true,
      startAt: true,
      endAt: true,
      coverEmployeeId: true,
      auto: true,
    },
  });
  if (rows.length === 0) return [];
  const live = await prisma.shift.findMany({
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
    .map((row) => ({
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      coverEmployeeId: row.coverEmployeeId,
      auto: row.auto,
    }));
}

