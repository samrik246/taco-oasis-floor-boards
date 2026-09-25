import { prisma } from "@/lib/db";
import { chicagoHourStart, chicagoHourEnd } from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";
import { createShiftAssignment, type ShiftAssignSummary } from "./service";

export type FreeFavorite = {
  shiftId: string;
  employeeId: string;
  firstName: string;
  lastName: string;
};

/**
 * Planner I — the Sugerido chip's candidate. A free favorite: preferred at
 * this station, a non-superseded shift that day on that board covering this
 * hour, and not already seated that hour. Several favorites: earliest
 * startAt, then shift id. The chip itself only shows when the hour is empty
 * at this station — checked first here too, since a taken hour has no
 * favorite to suggest.
 */
export async function freeFavoriteFor(params: {
  board: string;
  date: string;
  hour: number;
  stationId: string;
}): Promise<FreeFavorite | null> {
  const hourStart = chicagoHourStart(params.date, params.hour);
  const hourEnd = chicagoHourEnd(params.date, params.hour);

  const stationTaken = await prisma.assignment.count({
    where: { stationId: params.stationId, hourStart },
  });
  if (stationTaken > 0) return null;

  const shifts = await prisma.shift.findMany({
    where: { date: params.date, board: params.board, supersededAt: null },
    include: { employee: true },
  });
  const covering = shifts.filter((s) =>
    isHourInShift(hourStart, s.startAt, s.endAt, hourEnd),
  );
  if (covering.length === 0) return null;

  const abilities = await prisma.employeeStationAbility.findMany({
    where: {
      stationId: params.stationId,
      level: "preferred",
      employeeId: { in: covering.map((s) => s.employeeId) },
    },
  });
  const preferredIds = new Set(abilities.map((a) => a.employeeId));
  const candidates = covering.filter((s) => preferredIds.has(s.employeeId));
  if (candidates.length === 0) return null;

  const busyRows = await prisma.assignment.findMany({
    where: { hourStart, employeeId: { in: candidates.map((c) => c.employeeId) } },
    select: { employeeId: true },
  });
  const busyIds = new Set(busyRows.map((b) => b.employeeId));
  const free = candidates.filter((c) => !busyIds.has(c.employeeId));
  if (free.length === 0) return null;

  free.sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
  );
  const best = free[0]!;
  return {
    shiftId: best.id,
    employeeId: best.employeeId,
    firstName: best.employee.firstName,
    lastName: best.employee.lastName,
  };
}

export type SuggestAssignResult =
  | { ok: true; summary: ShiftAssignSummary }
  | { ok: false; status: 422; error: string };

/**
 * The chip's tap. Recomputes the free favorite fresh and only writes when
 * the requested shift is still that exact candidate — a stale chip (someone
 * else got seated a moment earlier, or this person is no longer preferred)
 * writes nothing. The write is the whole shift, same as A and G.
 */
export async function suggestAssign(params: {
  board: string;
  date: string;
  hour: number;
  stationId: string;
  shiftId: string;
}): Promise<SuggestAssignResult> {
  const best = await freeFavoriteFor(params);
  if (!best || best.shiftId !== params.shiftId) {
    return { ok: false, status: 422, error: "Not a free favorite" };
  }
  const result = await createShiftAssignment({
    shiftId: params.shiftId,
    stationId: params.stationId,
    date: params.date,
  });
  if (!result.ok) {
    return { ok: false, status: 422, error: "Assign rejected" };
  }
  return { ok: true, summary: result.summary };
}
