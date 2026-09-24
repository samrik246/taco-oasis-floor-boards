import { prisma } from "@/lib/db";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ParseResult } from "@/lib/parser/schedule-parser";
import { seedAbilitiesFromPositions } from "@/lib/rules/abilities";
import {
  planReconcile,
  type DatePreview,
  type ExistingShift,
  type ReconcilePlan,
  type Refusal,
} from "@/lib/import/reconcile";

/**
 * Persist a parse result. Never writes pay columns or staff email (they are
 * not on ParsedShift). Upserts employees by externalId and keeps their names
 * current. Existing ability edits always win over import hints.
 *
 * A file whose dates are all new imports in one step. A file that touches an
 * already-imported date goes through preview, then commit (C1 step 5): see
 * `reconcile.ts` for the rules. The exact same file again is refused by
 * fingerprint and changes nothing.
 */
export function fingerprintFor(parsed: ParseResult): string {
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

export class ImportRefusedError extends Error {
  constructor(
    message: string,
    readonly code: "DUPLICATE" | "EMPTY" | "REFUSED" | "PREVIEW_REQUIRED" | "FINGERPRINT_MISMATCH" | "BOARD_CHANGED",
    readonly refusals: Refusal[] = [],
  ) {
    super(message);
    this.name = "ImportRefusedError";
  }
}

export type ImportPreview = {
  fingerprint: string;
  planDigest: string;
  /** False when the file only adds new dates: the upload screen imports in one step. */
  needsConfirm: boolean;
  dates: DatePreview[];
  refusals: Refusal[];
  rowCount: number;
};

export type ImportCommitResult = {
  importBatchId: string;
  rowCount: number;
  dates: DatePreview[];
};

const DUPLICATE_MESSAGE =
  "This exact schedule was already imported. Nothing changed: no shifts, assignments or abilities were touched.";

type Tx = Prisma.TransactionClient;

async function loadExisting(tx: Tx | typeof prisma, dates: string[]): Promise<ExistingShift[]> {
  const rows = await tx.shift.findMany({
    where: { date: { in: dates }, supersededAt: null },
    include: {
      employee: { select: { externalId: true } },
      assignments: { select: { id: true, stationId: true, hourStart: true, hourEnd: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    externalId: r.employee.externalId,
    date: r.date,
    startAt: r.startAt,
    endAt: r.endAt,
    sourcePosition: r.sourcePosition,
    board: r.board,
    assignments: r.assignments,
  }));
}

function fileDates(parsed: ParseResult): string[] {
  return [...new Set([...parsed.dates, ...Object.keys(parsed.skippedOpenShifts ?? {})])].sort();
}

async function buildPlan(
  tx: Tx | typeof prisma,
  parsed: ParseResult,
  fingerprint: string,
  now: Date,
): Promise<ReconcilePlan> {
  const existing = await loadExisting(tx, fileDates(parsed));
  return planReconcile({
    fingerprint,
    shifts: parsed.shifts,
    skippedOpenShifts: parsed.skippedOpenShifts,
    existing,
    now,
  });
}

function assertImportable(parsed: ParseResult) {
  if (parsed.shifts.length === 0) {
    throw new ImportRefusedError("Schedule contains no shifts to import.", "EMPTY");
  }
}

/** Preview: counts per date, what would be removed, and refusals. Writes nothing. */
export async function previewImport(
  parsed: ParseResult,
  opts: { now?: Date } = {},
): Promise<ImportPreview> {
  assertImportable(parsed);
  const fingerprint = fingerprintFor(parsed);
  const duplicate = await prisma.importBatch.findUnique({ where: { fingerprint } });
  if (duplicate) throw new ImportRefusedError(DUPLICATE_MESSAGE, "DUPLICATE");
  const plan = await buildPlan(prisma, parsed, fingerprint, opts.now ?? new Date());
  return {
    fingerprint,
    planDigest: plan.digest,
    needsConfirm: plan.touchesImportedDates,
    dates: plan.dates,
    refusals: plan.refusals,
    rowCount: parsed.shifts.length,
  };
}

/**
 * Commit. With `expected` (from the preview) the file fingerprint and the plan
 * digest must match what is recomputed inside the transaction; a tablet that
 * assigned someone since the preview changes the digest and the commit refuses.
 * Without `expected`, only a file whose dates are all new may commit.
 * Any failure changes nothing.
 */
export async function commitImport(
  parsed: ParseResult,
  filename: string,
  opts: { now?: Date; expected?: { fingerprint: string; planDigest: string } } = {},
): Promise<ImportCommitResult> {
  assertImportable(parsed);
  const fingerprint = fingerprintFor(parsed);
  const now = opts.now ?? new Date();
  if (opts.expected && opts.expected.fingerprint !== fingerprint) {
    throw new ImportRefusedError(
      "This is not the file that was previewed. Nothing changed. Upload it again to see its preview.",
      "FINGERPRINT_MISMATCH",
    );
  }

  return prisma.$transaction(async (tx) => {
    const duplicate = await tx.importBatch.findUnique({ where: { fingerprint } });
    if (duplicate) throw new ImportRefusedError(DUPLICATE_MESSAGE, "DUPLICATE");

    const plan = await buildPlan(tx, parsed, fingerprint, now);
    if (plan.refusals.length > 0) {
      throw new ImportRefusedError(
        plan.refusals.map((r) => r.message).join(" "),
        "REFUSED",
        plan.refusals,
      );
    }
    if (!opts.expected && plan.touchesImportedDates) {
      throw new ImportRefusedError(
        "This file changes a day that is already imported. Preview it and confirm.",
        "PREVIEW_REQUIRED",
      );
    }
    if (opts.expected && opts.expected.planDigest !== plan.digest) {
      throw new ImportRefusedError(
        "The board changed after the preview: a spot was assigned or cleared, or a new hour started. Nothing changed. Check the fresh preview and confirm again.",
        "BOARD_CHANGED",
      );
    }

    const batch = await tx.importBatch.create({
      data: { filename, fingerprint, rowCount: parsed.shifts.length },
    });

    // Employees: create new people, keep names current. Email is never written.
    const nameByExternal = new Map<string, { firstName: string; lastName: string }>();
    const positionsByExternal = new Map<string, string[]>();
    for (const s of parsed.shifts) {
      nameByExternal.set(s.externalId, { firstName: s.firstName, lastName: s.lastName });
      positionsByExternal.set(s.externalId, [
        ...(positionsByExternal.get(s.externalId) ?? []),
        s.sourcePosition,
      ]);
    }
    const employeeIdByExternal = new Map<string, string>();
    for (const [externalId, info] of nameByExternal) {
      const emp = await tx.employee.upsert({
        where: { externalId },
        create: { externalId, firstName: info.firstName, lastName: info.lastName },
        update: { firstName: info.firstName, lastName: info.lastName },
      });
      employeeIdByExternal.set(externalId, emp.id);
      // Seed only missing abilities. A manager's manual ability edit is authoritative.
      for (const seed of seedAbilitiesFromPositions(positionsByExternal.get(externalId) ?? [])) {
        await tx.employeeStationAbility.upsert({
          where: { employeeId_stationId: { employeeId: emp.id, stationId: seed.stationId } },
          create: { employeeId: emp.id, stationId: seed.stationId, level: seed.level },
          update: {},
        });
      }
    }

    const removeIds = plan.actions.flatMap((a) =>
      "removeAssignments" in a ? a.removeAssignments.map((r) => r.id) : [],
    );
    if (removeIds.length > 0) {
      const deleted = await tx.assignment.deleteMany({ where: { id: { in: removeIds } } });
      if (deleted.count !== removeIds.length) {
        throw new ImportRefusedError(
          "The board changed during the import. Nothing changed. Upload the file again.",
          "BOARD_CHANGED",
        );
      }
    }

    const createShift = (n: (typeof parsed.shifts)[number]) => {
      const employeeId = employeeIdByExternal.get(n.externalId);
      if (!employeeId) throw new Error(`Missing employee for ${n.externalId}`);
      return tx.shift.create({
        data: {
          employeeId,
          date: n.date,
          startAt: n.startAt,
          endAt: n.endAt,
          sourcePosition: n.sourcePosition,
          board: n.board,
          importBatchId: batch.id,
        },
      });
    };
    const supersede = (id: string) =>
      tx.shift.update({
        where: { id },
        data: { supersededAt: now, supersededByBatchId: batch.id },
      });

    const toCreate = new Set<(typeof parsed.shifts)[number]>();
    for (const a of plan.actions) {
      switch (a.kind) {
        case "unchanged":
          break;
        case "changed":
          await tx.shift.update({
            where: { id: a.old.id },
            data: { startAt: a.next.startAt, endAt: a.next.endAt },
          });
          break;
        case "replaced":
          await supersede(a.old.id);
          toCreate.add(a.next);
          break;
        case "removed":
          await supersede(a.old.id);
          break;
        case "added":
          toCreate.add(a.next);
          break;
      }
    }
    // New shifts in the order the export lists them.
    for (const n of parsed.shifts) {
      if (toCreate.has(n)) await createShift(n);
    }

    return { importBatchId: batch.id, rowCount: parsed.shifts.length, dates: plan.dates };
  });
}

/**
 * One-step import for a file whose dates are all new (sample button, first
 * upload of a day). A file that touches an imported date must be previewed.
 */
export async function persistImport(
  parsed: ParseResult,
  filename: string,
): Promise<{ importBatchId: string; rowCount: number }> {
  const { importBatchId, rowCount } = await commitImport(parsed, filename);
  return { importBatchId, rowCount };
}
