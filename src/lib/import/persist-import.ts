import { prisma } from "@/lib/db";
import type { ParseResult } from "@/lib/parser/schedule-parser";
import { seedAbilitiesFromPositions } from "@/lib/rules/abilities";

/**
 * Persist a parse result. Never writes pay columns (they are already stripped
 * from ParsedShift). Upserts employees by externalId; creates a new ImportBatch
 * and Shift rows for every schedule row (including multiple positions per employee).
 * Seeds EmployeeStationAbility from Position hints (SPEC §4.7).
 */
export async function persistImport(
  parsed: ParseResult,
  filename: string,
): Promise<{ importBatchId: string; rowCount: number }> {
  const rowCount = parsed.shifts.length;

  return prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.create({
      data: { filename, rowCount },
    });

    // Upsert employees first
    const byExternal = new Map<string, { firstName: string; lastName: string; email: string | null }>();
    const positionsByExternal = new Map<string, string[]>();
    for (const s of parsed.shifts) {
      byExternal.set(s.externalId, {
        firstName: s.firstName,
        lastName: s.lastName,
        email: s.email,
      });
      const list = positionsByExternal.get(s.externalId) ?? [];
      list.push(s.sourcePosition);
      positionsByExternal.set(s.externalId, list);
    }

    const employeeIdByExternal = new Map<string, string>();
    for (const [externalId, info] of byExternal) {
      const emp = await tx.employee.upsert({
        where: { externalId },
        create: {
          externalId,
          firstName: info.firstName,
          lastName: info.lastName,
          email: info.email,
        },
        update: {
          firstName: info.firstName,
          lastName: info.lastName,
          email: info.email,
        },
      });
      employeeIdByExternal.set(externalId, emp.id);

      // Re-seed abilities from all positions seen for this employee in this import
      const positions = positionsByExternal.get(externalId) ?? [];
      const seeds = seedAbilitiesFromPositions(positions);
      for (const seed of seeds) {
        await tx.employeeStationAbility.upsert({
          where: {
            employeeId_stationId: {
              employeeId: emp.id,
              stationId: seed.stationId,
            },
          },
          create: {
            employeeId: emp.id,
            stationId: seed.stationId,
            level: seed.level,
          },
          update: { level: seed.level },
        });
      }
    }

    for (const s of parsed.shifts) {
      const employeeId = employeeIdByExternal.get(s.externalId);
      if (!employeeId) throw new Error(`Missing employee for ${s.externalId}`);
      await tx.shift.create({
        data: {
          employeeId,
          date: s.date,
          startAt: s.startAt,
          endAt: s.endAt,
          sourcePosition: s.sourcePosition,
          board: s.board,
          importBatchId: batch.id,
        },
      });
    }

    return { importBatchId: batch.id, rowCount };
  });
}
