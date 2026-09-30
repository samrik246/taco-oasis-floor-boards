import { prisma } from "@/lib/db";
import { breakState } from "@/lib/breaks/status";
import { gerenteAuthority } from "@/lib/breaks/authority";

/** Shared by both tablets. No credentials, cover reasons, or truncated pending queue. */
export async function breakTimeline(date: string, now = new Date()) {
  const shifts = await prisma.shift.findMany({
    where: { date, board: { in: ["caja", "cocina"] }, supersededAt: null, boardRemoved: false },
    select: { id: true, employeeId: true, board: true, startAt: true, endAt: true, employee: { select: { firstName: true, lastName: true } } },
  });
  const rows = await prisma.staffBreak.findMany({
    where: { date, shiftId: { in: shifts.map(s => s.id) }, status: { in: ["pending", "booked", "ended"] } },
    select: { id: true, employeeId: true, board: true, status: true, startAt: true, endAt: true, actor: true, auto: true },
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
  });
  const people = new Map(shifts.map(s => [s.employeeId, s.employee]));
  const managers = await prisma.manager.findMany({ where: { active: true }, select: { id: true } });
  const authorized = await Promise.all(managers.map(m => gerenteAuthority(m.id, now)));
  return {
    date, asOf: now.toISOString(), gerenteAvailable: authorized.some(Boolean),
    people: [...people.entries()].map(([id, person]) => ({ id, name: `${person.firstName} ${person.lastName}`.trim(),
      shifts: shifts.filter(s => s.employeeId === id).map(s => ({ board: s.board, startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString() })),
    })),
    breaks: rows.map(row => ({
      id: row.id, employeeId: row.employeeId, firstName: people.get(row.employeeId)?.firstName ?? "",
      board: row.board, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString(),
      status: row.status, state: breakState(row, now),
      approval: row.status === "ended" ? null : row.status === "pending" || (row.actor !== row.employeeId && !row.auto) ? "gerente" : "automatic",
    })),
  };
}
