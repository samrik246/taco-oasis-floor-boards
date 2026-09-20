import { prisma } from "@/lib/db";
import type { ParseResult } from "@/lib/parser/schedule-parser";

/**
 * Persist a parse result. Never writes pay columns (they are already stripped
 * from ParsedShift). Upserts employees by externalId; creates a new ImportBatch
 * and Shift rows for every schedule row (including multiple positions per employee).
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
    for (const s of parsed.shifts) {
      byExternal.set(s.externalId, {
        firstName: s.firstName,
        lastName: s.lastName,
        email: s.email,
      });
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
