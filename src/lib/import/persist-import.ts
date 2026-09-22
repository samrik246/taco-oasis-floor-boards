import { prisma } from "@/lib/db";
import { createHash } from "node:crypto";
import type { ParseResult } from "@/lib/parser/schedule-parser";
import { seedAbilitiesFromPositions } from "@/lib/rules/abilities";

/**
 * Persist a parse result. Never writes pay columns (they are already stripped
 * from ParsedShift). Upserts employees by externalId; creates a new ImportBatch
 * and Shift rows for every schedule row (including multiple positions per employee).
 * A schedule is accepted once only: a repeated workbook is rejected by fingerprint,
 * and a different workbook that overlaps already-imported dates is rejected until a
 * replacement policy exists. Existing ability edits always win over import hints.
 */
function fingerprintFor(parsed: ParseResult): string {
  const rows = parsed.shifts
    .map((shift) => ({
      externalId: shift.externalId,
      date: shift.date,
      startAt: shift.startAt.toISOString(),
      endAt: shift.endAt.toISOString(),
      sourcePosition: shift.sourcePosition,
      board: shift.board,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export async function persistImport(
  parsed: ParseResult,
  filename: string,
): Promise<{ importBatchId: string; rowCount: number }> {
  const rowCount = parsed.shifts.length;
  if (rowCount === 0) throw new Error("Schedule contains no shifts to import.");
  const fingerprint = fingerprintFor(parsed);

  return prisma.$transaction(async (tx) => {
    const duplicate = await tx.importBatch.findUnique({
      where: { fingerprint },
    });
    if (duplicate) {
      throw new Error(
        "This exact schedule was already imported. No shifts or abilities were changed.",
      );
    }

    const overlap = await tx.shift.findFirst({
      where: { date: { in: parsed.dates } },
      select: { date: true },
    });
    if (overlap) {
      throw new Error(
        `Schedule overlaps ${overlap.date}, which is already imported. Corrected-schedule replacement is not supported; existing assignments and history were left unchanged.`,
      );
    }

    const batch = await tx.importBatch.create({
      data: { filename, fingerprint, rowCount },
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

      // Seed only missing abilities. A manager's manual ability edit is authoritative.
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
          update: {},
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
