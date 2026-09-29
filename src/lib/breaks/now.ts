import { prisma } from "@/lib/db";
import { chicagoToday } from "@/lib/upcoming/source";

export type BreakNowItem = { firstName: string; startAt: string; endAt: string };

export type BreakNowBody = {
  asOf: string;
  now: BreakNowItem[];
  next: BreakNowItem[];
};

/** Next list length for Rich's 4A. */
export const BREAK_NOW_NEXT_LIMIT = 3;

/**
 * The e2e server pins 09:30 Chicago so a morning break is on the now page.
 * The mini has no test root, so this stays the real clock there.
 */
export function breaksNow(explicit?: Date): Date {
  if (explicit) return explicit;
  const fixed = process.env.FLOOR_BOARDS_E2E_NOW;
  if (fixed && process.env.FLOOR_BOARDS_TEST_ROOT) {
    const parsed = new Date(fixed);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** Live shifts only, same filter as the hour stripe. Ended breaks are in neither list. */
export async function listBreaksNow(
  board: "caja" | "cocina",
  now: Date = breaksNow(),
): Promise<BreakNowBody> {
  const date = chicagoToday(now);
  const rows = await prisma.staffBreak.findMany({
    where: { board, date, status: "booked" },
    select: { employeeId: true, shiftId: true, startAt: true, endAt: true },
  });
  if (rows.length === 0) {
    return { asOf: now.toISOString(), now: [], next: [] };
  }
  const live = await prisma.shift.findMany({
    where: {
      id: { in: rows.map((row) => row.shiftId) },
      supersededAt: null,
      boardRemoved: false,
    },
    select: { id: true },
  });
  const liveIds = new Set(live.map((shift) => shift.id));
  const liveRows = rows.filter((row) => liveIds.has(row.shiftId));
  const people = await prisma.employee.findMany({
    where: { id: { in: [...new Set(liveRows.map((row) => row.employeeId))] } },
    select: { id: true, firstName: true },
  });
  const names = new Map(people.map((person) => [person.id, person.firstName]));
  const visible = liveRows.flatMap((row) => {
    const firstName = names.get(row.employeeId);
    if (firstName === undefined) return [];
    return [{ firstName, startAt: row.startAt, endAt: row.endAt }];
  });
  visible.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.firstName.localeCompare(b.firstName));
  const at = now.getTime();
  const current = visible.filter((row) => row.startAt.getTime() <= at && at < row.endAt.getTime());
  const upcoming = visible.filter((row) => row.startAt.getTime() > at);
  const item = (row: { firstName: string; startAt: Date; endAt: Date }): BreakNowItem => ({
    firstName: row.firstName,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
  });
  return {
    asOf: now.toISOString(),
    now: current.map(item),
    next: upcoming.slice(0, BREAK_NOW_NEXT_LIMIT).map(item),
  };
}
