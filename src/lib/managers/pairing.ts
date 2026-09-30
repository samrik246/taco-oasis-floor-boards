import { prisma } from "@/lib/db";
import { chicagoDateOffset } from "@/lib/date-math";
import { chicagoToday } from "@/lib/upcoming/source";
import { GERENTE_POSITIONS } from "@/lib/breaks/authority";

const publicManager = { id: true, name: true, active: true, role: true, employeeId: true } as const;

export async function pairingData(now = new Date()) {
  const through = chicagoToday(now);
  const from = chicagoDateOffset(through, -13);
  const [managers, shifts, retained] = await Promise.all([
    prisma.manager.findMany({ select: publicManager, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    prisma.shift.findMany({
      where: { date: { gte: from, lte: through }, sourcePosition: { in: [...GERENTE_POSITIONS] } },
      select: { employeeId: true, sourcePosition: true, employee: { select: { firstName: true, lastName: true } } },
    }),
    prisma.shift.findMany({ where: { date: { gte: from, lte: through } }, distinct: ["date"], select: { date: true } }),
  ]);
  const people = new Map<string, { id: string; name: string; positions: string[] }>();
  for (const shift of shifts) {
    const person = people.get(shift.employeeId) ?? { id: shift.employeeId, name: `${shift.employee.firstName} ${shift.employee.lastName}`.trim(), positions: [] };
    if (!person.positions.includes(shift.sourcePosition)) person.positions.push(shift.sourcePosition);
    people.set(person.id, person);
  }
  return {
    from, through, incompleteHistory: retained.length < 14, managers,
    people: [...people.values()].map(p => ({ ...p, positions: p.positions.sort() })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}

/** Nullable string linkage is validated by the app, never by a rebuilding FK migration. */
export async function pairManager(ownerId: string, managerId: string, employeeId: string | null) {
  return prisma.$transaction(async tx => {
    const owner = await tx.manager.findFirst({ where: { id: ownerId, active: true, role: "owner" }, select: { id: true } });
    if (!owner) return { ok: false as const, status: 403, error: "Owner access required" };
    const manager = await tx.manager.findUnique({ where: { id: managerId }, select: { id: true } });
    if (!manager) return { ok: false as const, status: 404, error: "Manager not found" };
    if (employeeId && !await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true } })) {
      return { ok: false as const, status: 422, error: "Schedule person not found" };
    }
    return { ok: true as const, manager: await tx.manager.update({ where: { id: managerId }, data: { employeeId }, select: publicManager }) };
  });
}
