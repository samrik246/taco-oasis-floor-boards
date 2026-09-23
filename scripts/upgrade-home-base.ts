import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type LegacyAssignment = { id: string; stationId: string; hourStart: Date; employeeId: string };
type BatchRow = { id: string; fingerprint: string | null };
type BatchShift = { importBatchId: string; externalId: string; date: string; startAt: Date; endAt: Date; sourcePosition: string; board: string };

function hash(rows: unknown): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function hasTable(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?', "table", name,
  );
  return rows.length > 0;
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${table}")`);
  return rows.some((row) => row.name === column);
}

/** ImportBatch rows; `fingerprint` is null when the column is not there yet. */
async function legacyBatches(): Promise<BatchRow[]> {
  if (!(await hasTable("ImportBatch"))) return [];
  if (!(await hasColumn("ImportBatch", "fingerprint"))) {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT id FROM "ImportBatch"');
    return rows.map((r) => ({ id: r.id, fingerprint: null }));
  }
  return prisma.$queryRawUnsafe<BatchRow[]>('SELECT id, fingerprint FROM "ImportBatch"');
}

async function preflight() {
  if (!(await hasTable("Assignment"))) {
    console.log("Upgrade preflight: empty database; schema bootstrap will run next.");
    return;
  }
  const assignments = await prisma.$queryRawUnsafe<LegacyAssignment[]>(
    'SELECT a.id, a.stationId, a.hourStart, s.employeeId FROM "Assignment" a JOIN "Shift" s ON s.id = a.shiftId',
  );
  const stationSlots = new Map<string, string[]>();
  const personSlots = new Map<string, string[]>();
  for (const row of assignments) {
    const hour = new Date(row.hourStart).toISOString();
    for (const [map, key] of [[stationSlots, `${row.stationId} @ ${hour}`], [personSlots, `${row.employeeId} @ ${hour}`]] as const) {
      map.set(key, [...(map.get(key) ?? []), row.id]);
    }
  }
  const duplicates = [...stationSlots, ...personSlots]
    .filter(([, ids]) => ids.length > 1)
    .map(([slot, ids]) => `${slot}: ${ids.join(", ")}`);
  if (duplicates.length) {
    throw new Error(`Legacy database has duplicate assignment slots. Resolve these before upgrade; no data was changed.\n${duplicates.join("\n")}`);
  }
  const batches = await legacyBatches();
  const shifts = await prisma.$queryRawUnsafe<BatchShift[]>(
    'SELECT s.importBatchId, e.externalId, s.date, s.startAt, s.endAt, s.sourcePosition, s.board FROM "Shift" s JOIN "Employee" e ON e.id = s.employeeId WHERE s.importBatchId IS NOT NULL',
  );
  const fingerprints = new Map<string, string[]>();
  // Stored fingerprints stay as written; a legacy backfill must not collide with them.
  for (const batch of batches) {
    if (batch.fingerprint != null) {
      fingerprints.set(batch.fingerprint, [...(fingerprints.get(batch.fingerprint) ?? []), batch.id]);
    }
  }
  for (const batch of batches.filter((b) => b.fingerprint == null)) {
    const rows = shifts.filter((shift) => shift.importBatchId === batch.id).map((shift) => ({
      externalId: shift.externalId, date: shift.date, startAt: shift.startAt.toISOString(), endAt: shift.endAt.toISOString(), sourcePosition: shift.sourcePosition, board: shift.board,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const fingerprint = hash(rows);
    fingerprints.set(fingerprint, [...(fingerprints.get(fingerprint) ?? []), batch.id]);
  }
  const duplicateBatches = [...fingerprints.entries()].filter(([, ids]) => ids.length > 1);
  if (duplicateBatches.length) {
    throw new Error(`Legacy database has duplicate imported schedules. Resolve these before upgrade; no data was changed.\n${duplicateBatches.map(([fingerprint, ids]) => `${fingerprint}: ${ids.join(", ")}`).join("\n")}`);
  }
  console.log(`Upgrade preflight passed for ${assignments.length} legacy assignments.`);
}

/** Add nullable columns only. Constraints wait until legacy values are backfilled. */
async function prepare() {
  if (!(await hasTable("Assignment"))) return;
  if (!(await hasColumn("Assignment", "employeeId"))) {
    await prisma.$executeRawUnsafe('ALTER TABLE "Assignment" ADD COLUMN employeeId TEXT');
  }
  if (await hasTable("ImportBatch") && !(await hasColumn("ImportBatch", "fingerprint"))) {
    await prisma.$executeRawUnsafe('ALTER TABLE "ImportBatch" ADD COLUMN fingerprint TEXT');
  }
  console.log("Upgrade prepare completed.");
}

async function backfill() {
  if (!(await hasTable("Assignment"))) return;
  await prisma.$executeRawUnsafe(
    'UPDATE "Assignment" SET employeeId = (SELECT employeeId FROM "Shift" WHERE "Shift".id = "Assignment".shiftId) WHERE employeeId IS NULL',
  );
  // Only legacy batches with no fingerprint. A fingerprint written at import is
  // the uploaded file's hash; after a same-day re-import (C1) a batch's linked
  // shifts no longer equal its file, so recomputing would break the duplicate
  // refusal and could collide (two re-imports that only changed times link no shifts).
  const batches = (await legacyBatches()).filter((b) => b.fingerprint == null);
  const shifts = await prisma.$queryRawUnsafe<BatchShift[]>(
    'SELECT s.importBatchId, e.externalId, s.date, s.startAt, s.endAt, s.sourcePosition, s.board FROM "Shift" s JOIN "Employee" e ON e.id = s.employeeId WHERE s.importBatchId IS NOT NULL',
  );
  for (const batch of batches) {
    const rows = shifts.filter((shift) => shift.importBatchId === batch.id).map((shift) => ({
      externalId: shift.externalId,
      date: shift.date,
      startAt: shift.startAt.toISOString(),
      endAt: shift.endAt.toISOString(),
      sourcePosition: shift.sourcePosition,
      board: shift.board,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    await prisma.$executeRawUnsafe('UPDATE "ImportBatch" SET fingerprint = ? WHERE id = ?', hash(rows), batch.id);
  }
  console.log(`Upgrade backfill completed for ${batches.length} import batch(es).`);
}

async function enforce() {
  if (!(await hasTable("Assignment"))) return;
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "Assignment_stationId_hourStart_key" ON "Assignment"("stationId", "hourStart")');
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "Assignment_employeeId_hourStart_key" ON "Assignment"("employeeId", "hourStart")');
  if (await hasTable("ImportBatch")) {
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "ImportBatch_fingerprint_key" ON "ImportBatch"("fingerprint")');
  }
  console.log("Upgrade constraints enforced.");
}

async function main() {
  const mode = process.argv[2];
  if (mode === "preflight") await preflight();
  else if (mode === "prepare") await prepare();
  else if (mode === "backfill") await backfill();
  else if (mode === "enforce") await enforce();
  else throw new Error("usage: tsx scripts/upgrade-home-base.ts <preflight|prepare|backfill|enforce>");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
