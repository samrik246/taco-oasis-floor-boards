import { prisma } from "@/lib/db";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { listBreakCovers, numberedSeatCover } from "@/lib/breaks/covers";
import { starWorld } from "@/lib/breaks/rules";
import { assessStarGate } from "@/lib/slices/break-gate";

export type ApprovalMode = "automatic" | "gerente";

/** One world per board read. Save re-reads this world under the write lock. */
export async function loadBreakPreview(date: string, board: "caja" | "cocina", employeeId: string) {
  const world = await starWorld(prisma, date, board);
  const ids = [...new Set(world.shifts.map(s => s.employeeId))];
  const [abilities, people, defaults] = await Promise.all([
    prisma.employeeStationAbility.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, stationId: true, level: true } }),
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true } }),
    loadColumnDefaults(),
  ]);
  const base = { ...world, date, board, employeeId, abilities, defaults, names: new Map(people.map(p => [p.id, p.firstName])) };
  const approval = (startAt: Date, endAt: Date): ApprovalMode | null => {
    if (world.breaks.some(row => row.status === "booked" && row.employeeId !== employeeId
      && row.startAt < endAt && row.endAt > startAt
      && (row.coverEmployeeId === employeeId || row.shuffleEmployeeId === employeeId))) return null;
    const input = { ...base, startAt, endAt };
    const initial = assessStarGate(input);
    if (!("code" in initial)) return "automatic";
    if (initial.code !== "NEEDS_COVER") return null;
    const numbered = numberedSeatCover(input);
    if (!numbered) return "gerente";
    const covered = assessStarGate({ ...input, coverEmployeeId: numbered.employeeId });
    return "code" in covered ? null : "automatic";
  };
  return { context: base, approval, covers: (startAt: Date, endAt: Date) => listBreakCovers({ ...base, startAt, endAt }) };
}

export async function approvalPreview(date: string, board: "caja" | "cocina", employeeId: string) {
  return (await loadBreakPreview(date, board, employeeId)).approval;
}
