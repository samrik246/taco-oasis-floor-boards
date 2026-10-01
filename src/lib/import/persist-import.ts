import type { PrismaClient } from "@prisma/client";
import type { ImportInitiator } from "@/lib/quarter/import";
import { quarterState, worldRevision, digest } from "@/lib/quarter/schema";
import { resolvePaintWorld } from "@/lib/quarter/world";
import { withReleaseLease, assertReleaseLease } from "@/lib/quarter/lease";
import { assertArtifactCompatibility } from "@/lib/quarter/compatibility";
import { commitQuarterImport, importReceipt, saveImportReceipt } from "@/lib/quarter/import";
import { placeFixedForImportedDates } from "@/lib/assignments/fixed-assign";
import { prisma } from "@/lib/db";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ParseResult } from "@/lib/parser/schedule-parser";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { seedAbilitiesFromPositions } from "@/lib/rules/abilities";
import { validateAssignment } from "@/lib/rules/assign";
import { chicagoHourOf } from "@/lib/hour-grid";
import {
  planReconcile,
  type DatePreview,
  type ExistingShift,
  type ReconcilePlan,
  type Refusal,
} from "@/lib/import/reconcile";
import { planRemovalIdentity, type RemovalDecision } from "@/lib/import/removal-identity";
import { seatNumberForWrite } from "@/lib/assignments/seat-number";
import { dropImportedBreaks } from "@/lib/breaks/import-drop";
import { endImportedOverlays } from "@/lib/overlays/write";

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
    readonly code: "DUPLICATE" | "EMPTY" | "REFUSED" | "PREVIEW_REQUIRED" | "FINGERPRINT_MISMATCH" | "BOARD_CHANGED" | "DUPLICATE_LEGACY_RECEIPT_UNAVAILABLE",
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
  fixedSkipped?: { shiftId:string;hour:number;reason:string }[];
  replayed?: boolean;
};

const DUPLICATE_MESSAGE =
  "This exact schedule was already imported. Nothing changed: no shifts, assignments or abilities were touched.";

type Tx = Prisma.TransactionClient;

function takeoverConflict(board: string, date: string, stationId: string, hour: number, detail: string): ImportRefusedError {
  const refusal: Refusal = {
    code: "TAKEOVER_CONFLICT", board, date,
    message: `The replacement shift cannot inherit ${stationId} at ${hour}:00 on ${date}: ${detail}. Nothing changed. Review the board and import again.`,
  };
  return new ImportRefusedError(refusal.message, "REFUSED", [refusal]);
}

async function loadExisting(tx: Tx | typeof prisma, dates: string[]): Promise<ExistingShift[]> {
  const rows = await tx.shift.findMany({
    where: { date: { in: dates }, supersededAt: null },
    include: {
      employee: { select: { externalId: true } },
      assignments: { select: { id: true, stationId: true, hourStart: true, hourEnd: true } },
    },
  });
  const active = (await quarterState(tx))?.phase === "active";
  const worlds = active ? await Promise.all(dates.map(date => resolvePaintWorld(tx,date))) : [];
  return rows.map((r) => ({
    id:r.id, externalId:r.employee.externalId, date:r.date, startAt:r.startAt,endAt:r.endAt,sourcePosition:r.sourcePosition,board:r.board,
    assignments: active ? worlds.find(w=>w.date===r.date)!.hours.filter(h=>h.shiftId===r.id).flatMap(h=>h.segments.filter(s=>s.state==="assigned").map(s=>({
      id:s.assignmentId ?? s.id,stationId:s.stationId!,hourStart:new Date(s.startMs),hourEnd:new Date(s.endMs),canonicalHourStart:new Date(h.hourStartMs),
    }))) : r.assignments,
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
): Promise<ReconcilePlan & { removalDecisions: RemovalDecision[] }> {
  const dates = fileDates(parsed);
  const existing = await loadExisting(tx, dates);
  const plan = planReconcile({
    fingerprint,
    shifts: parsed.shifts,
    skippedOpenShifts: parsed.skippedOpenShifts,
    existing,
    now,
  });
  const removals = await tx.shiftRemoval.findMany({
    where: { date: { in: dates }, state: "removed" },
  });
  const identity = planRemovalIdentity({
    removals, existing, incoming: parsed.shifts, actions: plan.actions,
  });
  plan.touchesImportedDates ||= removals.length > 0;
  plan.refusals.push(...identity.refusals);
  // A manager remove/restore or a source relink between Preview and Confirm
  // must invalidate the preview even when no station cells changed.
  plan.digest = createHash("sha256").update(JSON.stringify([
    plan.digest,
    removals.map((r) => [r.id, r.shiftId, r.revision, r.externalId, r.date,
      r.board, r.sourcePosition, r.startAt.toISOString(), r.endAt.toISOString()]).sort(),
    identity.decisions.map((d) => [d.overrideId, d.action,
      d.next?.startAt.toISOString(), d.next?.endAt.toISOString()]).sort(),
  ])).digest("hex");
  const schema = await quarterState(tx);
  if (schema) plan.digest = digest([plan.digest,schema.databaseEpoch,await worldRevision(tx)]);
  return Object.assign(plan, { removalDecisions: identity.decisions });
}

function assertImportable(parsed: ParseResult) {
  if (parsed.shifts.length === 0) {
    throw new ImportRefusedError("Schedule contains no shifts to import.", "EMPTY");
  }
}

/** Preview: counts per date, what would be removed, and refusals. Writes nothing. */
export async function previewImport(
  parsed: ParseResult,
  opts: { now?: Date; client?:PrismaClient } = {},
): Promise<ImportPreview> {
  const client=opts.client??prisma;
  assertImportable(parsed);
  const fingerprint = fingerprintFor(parsed);
  return client.$transaction(async tx => {
  const duplicate = await tx.importBatch.findUnique({ where: { fingerprint } });
  if (duplicate) {
    const schema=await quarterState(tx);
    if (!schema || schema.phase==="prepared") throw new ImportRefusedError(DUPLICATE_MESSAGE,"DUPLICATE");
    const replay=await importReceipt(tx,fingerprint,duplicate.id);
    if (!replay) throw new ImportRefusedError(DUPLICATE_MESSAGE,"DUPLICATE_LEGACY_RECEIPT_UNAVAILABLE");
    return {fingerprint,planDigest:"receipt-replay",needsConfirm:false,dates:replay.dates,refusals:[],rowCount:replay.rowCount};
  }
  const plan = await buildPlan(tx, parsed, fingerprint, opts.now ?? new Date());
  return {
    fingerprint,
    planDigest: plan.digest,
    needsConfirm: plan.touchesImportedDates,
    dates: plan.dates,
    refusals: plan.refusals,
    rowCount: parsed.shifts.length,
  };
  });
}

/** Schedule rows and fixed seats share this transaction. The timeout covers a week of hourly seat writes; exceeding it rolls the fingerprint back. */
const IMPORT_TX = { maxWait: 5_000, timeout: 60_000 } as const;

/**
 * Commit. With `expected` (from the preview) the file fingerprint and the plan
 * digest must match what is recomputed inside the transaction; a tablet that
 * assigned someone since the preview changes the digest and the commit refuses.
 * Without `expected`, only a file whose dates are all new may commit.
 * Fixed seats are written in the same transaction. A throw or a timeout
 * rolls the schedule and the fingerprint back, so a retry is not a duplicate
 * and cannot leave the seats half-placed.
 */
export async function commitImport(
  parsed: ParseResult,
  filename: string,
  opts: { now?: Date; expected?: { fingerprint: string; planDigest: string };client?:PrismaClient;initiator?:ImportInitiator } = {},
): Promise<ImportCommitResult> {
  const client=opts.client??prisma;
  assertImportable(parsed);
  const fingerprint = fingerprintFor(parsed);
  const now = opts.now ?? new Date();
  if (opts.expected && opts.expected.fingerprint !== fingerprint) {
    throw new ImportRefusedError(
      "This is not the file that was previewed. Nothing changed. Upload it again to see its preview.",
      "FINGERPRINT_MISMATCH",
    );
  }

  const committed = await withReleaseLease(async () => {
    await assertReleaseLease();
    await assertArtifactCompatibility(client);
    return client.$transaction(async (tx) => {
    await tx.staffBreakLock.upsert({where:{id:1},create:{id:1},update:{updatedAt:now}});
    const schema=await quarterState(tx);
    const revisionBefore=schema ? await worldRevision(tx) : null;
    const duplicate = await tx.importBatch.findUnique({ where: { fingerprint } });
    if (duplicate) {
      if (!schema || schema.phase==="prepared") throw new ImportRefusedError(DUPLICATE_MESSAGE,"DUPLICATE");
      const replay=await importReceipt(tx,fingerprint,duplicate.id);
      if (!replay) throw new ImportRefusedError(DUPLICATE_MESSAGE,"DUPLICATE_LEGACY_RECEIPT_UNAVAILABLE");
      return {...replay,replayed:true};
    }

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

    if (schema?.phase === "active") return commitQuarterImport(tx,{parsed,filename,fingerprint,plan,now,revisionBefore:revisionBefore!,initiator:opts.initiator});
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
    const columnDefaults = await loadColumnDefaults(tx);
    for (const [externalId, info] of nameByExternal) {
      const emp = await tx.employee.upsert({
        where: { externalId },
        create: { externalId, firstName: info.firstName, lastName: info.lastName },
        update: { firstName: info.firstName, lastName: info.lastName },
      });
      employeeIdByExternal.set(externalId, emp.id);
      // Seed only missing abilities. A saved row stays as the manager left it.
      // A missing bien follows the column default, so Nuevos no is stored as no.
      for (const seed of seedAbilitiesFromPositions(positionsByExternal.get(externalId) ?? [])) {
        const columnDefault = columnDefaults.get(seed.stationId);
        const level = seed.level === "ok" && columnDefault === "forbidden" ? "forbidden" : seed.level;
        await tx.employeeStationAbility.upsert({
          where: { employeeId_stationId: { employeeId: emp.id, stationId: seed.stationId } },
          create: { employeeId: emp.id, stationId: seed.stationId, level },
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
    const supersededShiftIds: string[] = [];
    const changedShiftIds: string[] = [];
    const boardRemovedShiftIds: string[] = [];
    for (const a of plan.actions) {
      switch (a.kind) {
        case "unchanged":
          break;
        case "changed":
          await tx.shift.update({
            where: { id: a.old.id },
            data: { startAt: a.next.startAt, endAt: a.next.endAt },
          });
          changedShiftIds.push(a.old.id);
          break;
        case "replaced":
          await supersede(a.old.id);
          supersededShiftIds.push(a.old.id);
          toCreate.add(a.next);
          break;
        case "removed":
          await supersede(a.old.id);
          supersededShiftIds.push(a.old.id);
          break;
        case "added":
          toCreate.add(a.next);
          break;
        case "takeover":
          await supersede(a.old.id);
          supersededShiftIds.push(a.old.id);
          toCreate.add(a.next);
          break;
      }
    }
    // New shifts in the order the export lists them.
    const created = new Map<(typeof parsed.shifts)[number], Awaited<ReturnType<typeof createShift>>>();
    for (const n of parsed.shifts) {
      if (toCreate.has(n)) created.set(n, await createShift(n));
    }

    for (const decision of plan.removalDecisions) {
      if (decision.action === "unchanged") continue;
      const nextShift = decision.next && (created.get(decision.next) ??
        (plan.actions.find((action) => "next" in action && action.next === decision.next &&
          action.kind === "changed") as Extract<typeof plan.actions[number], { kind: "changed" }> | undefined)?.old);
      const shiftId = decision.action === "source-missing" ? null : nextShift?.id;
      if (decision.action !== "source-missing" && !shiftId) {
        throw new ImportRefusedError("The removed shift changed during import.", "BOARD_CHANGED");
      }
      if (shiftId) {
        await tx.shift.update({ where: { id: shiftId }, data: { boardRemoved: true } });
        boardRemovedShiftIds.push(shiftId);
      }
      const updated = await tx.shiftRemoval.update({
        where: { id: decision.overrideId },
        data: {
          shiftId,
          ...(decision.next ? {
            startAt: decision.next.startAt,
            endAt: decision.next.endAt,
          } : {}),
          revision: { increment: 1 },
        },
      });
      await tx.shiftRemovalEvent.create({ data: {
        overrideId: updated.id,
        action: decision.action,
        revision: updated.revision,
        reason: "Schedule re-import",
        sourceJson: JSON.stringify({ externalId: updated.externalId, date: updated.date,
          board: updated.board, sourcePosition: updated.sourcePosition,
          startAt: updated.startAt.toISOString(), endAt: updated.endAt.toISOString(), shiftId }),
        cellsJson: updated.cellsJson,
      } });
    }

    // Re-create only future station cells on an unambiguous incoming shift.
    // Started cells stay on the superseded shift as the outgoing person's history.
    for (const action of plan.actions) {
      if (action.kind !== "takeover") continue;
      const incoming = created.get(action.next);
      if (!incoming) throw new Error("Missing created takeover shift");
      for (const cell of action.removeAssignments) {
        const hour = chicagoHourOf(cell.hourStart);
        const station = await tx.station.findUnique({ where: { id: cell.stationId } });
        if (!station) throw takeoverConflict(action.next.board, action.next.date, cell.stationId, hour, "station missing");
        const ability = await tx.employeeStationAbility.findUnique({
          where: { employeeId_stationId: { employeeId: incoming.employeeId, stationId: cell.stationId } },
        });
        const occupancy = await tx.assignment.count({ where: { stationId: cell.stationId, hourStart: cell.hourStart } });
        const personBusy = await tx.assignment.count({ where: { employeeId: incoming.employeeId, hourStart: cell.hourStart } });
        const violations = validateAssignment({
          hourStart: cell.hourStart, hourEnd: cell.hourEnd,
          shiftStart: incoming.startAt, shiftEnd: incoming.endAt,
          stationId: station.id, stationBoard: station.board, shiftBoard: incoming.board,
          maxConcurrent: station.maxConcurrent, existingOccupancy: occupancy,
          abilityLevel: levelWhenUnset(ability?.level, columnDefaults.get(cell.stationId)),
          personAlreadyAssignedAtHour: personBusy > 0, chicagoHour: hour,
        });
        if (violations.length > 0) {
          throw takeoverConflict(action.next.board, action.next.date, cell.stationId, hour,
            violations.map((v) => v.code).join(", "));
        }
        try {
          const seatNumber = await seatNumberForWrite(tx, {
            stationId: cell.stationId,
            hourStart: cell.hourStart,
            employeeId: incoming.employeeId,
          });
          await tx.assignment.create({
            data: {
              shiftId: incoming.id, employeeId: incoming.employeeId,
              stationId: cell.stationId, hourStart: cell.hourStart, hourEnd: cell.hourEnd,
              seatNumber,
            },
          });
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
            throw takeoverConflict(action.next.board, action.next.date, cell.stationId, hour, "station or person already assigned");
          }
          throw error;
        }
      }
    }

    await dropImportedBreaks(tx, { supersededShiftIds, changedShiftIds, boardRemovedShiftIds });
    await endImportedOverlays(tx, { supersededShiftIds, boardRemovedShiftIds });
    await placeFixedForImportedDates(plan.dates.map((row) => row.date), tx);

    const result={ importBatchId: batch.id, rowCount: parsed.shifts.length, dates: plan.dates };
    if(schema)await saveImportReceipt(tx,{parsed,initiator:opts.initiator,fingerprint,filename,planDigest:plan.digest,revisionBefore:revisionBefore!,result,now});
    return result;
  }, IMPORT_TX);
  });
  return committed;
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
