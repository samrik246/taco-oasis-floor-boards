import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { assertReleaseLease } from "./lease";
import { QUARTER_MIGRATION } from "./migration-sql";

export type QuarterDb = Prisma.TransactionClient;
export class QuarterRefused extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(k => record[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const MIGRATION_SHA256 = digest(QUARTER_MIGRATION);
export type QuarterState = { schemaVersion: number; phase: "prepared" | "active"; databaseEpoch: string; minReader: number; minWriter: number; migrationSha256: string };
export async function quarterState(db: QuarterDb): Promise<QuarterState | null> {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name='QuarterSchema'");
  if (!tables.length) return null;
  const rows = await db.$queryRawUnsafe<QuarterState[]>("SELECT schemaVersion,phase,databaseEpoch,minReader,minWriter,migrationSha256 FROM QuarterSchema WHERE id=1");
  const row = rows[0];
  if (!row || Number(row.schemaVersion) !== 2 || !["prepared", "active"].includes(row.phase) || row.migrationSha256 !== MIGRATION_SHA256)
    throw new QuarterRefused("QUARTER_SCHEMA_INCOMPATIBLE", 503);
  return { ...row, schemaVersion: Number(row.schemaVersion), minReader: Number(row.minReader), minWriter: Number(row.minWriter) };
}
export async function worldRevision(db: QuarterDb): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ revision: string }[]>("SELECT CAST(revision AS TEXT) AS revision FROM QuarterWorldRevision WHERE id=1");
  if (!rows[0]) throw new QuarterRefused("QUARTER_REVISION_MISSING", 503);
  return rows[0].revision;
}
export async function requireLegacy(db: QuarterDb): Promise<void> {
  if ((await quarterState(db))?.phase === "active") throw new QuarterRefused("CLIENT_UPGRADE_REQUIRED", 426);
}
const normalized = (sql: string) => sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
export async function verifyQuarterSchema(db: QuarterDb): Promise<void> {
  const actual = await db.$queryRawUnsafe<{ name: string; sql: string }[]>("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL");
  const byName = new Map(actual.map(r => [r.name, normalized(r.sql)]));
  for (const sql of QUARTER_MIGRATION) {
    const name = /^CREATE (?:TABLE|INDEX|TRIGGER) (\w+)/.exec(sql)![1];
    if (byName.get(name) !== normalized(sql)) throw new QuarterRefused(`QUARTER_SCHEMA_DRIFT:${name}`, 503);
  }
  await quarterState(db);
}

/** Caller holds the release lease; transaction and byte-for-byte schema verification are internal. */
export async function migrateQuarterStorage(client: PrismaClient): Promise<{ databaseEpoch: string; repeated: boolean }> {
  await assertReleaseLease();
  return client.$transaction(async db => {
    await db.staffBreakLock.upsert({ where: { id: 1 }, create: { id: 1 }, update: { updatedAt: new Date() } });
    const prior = await quarterState(db);
    if (prior) {
      await verifyQuarterSchema(db);
      return { databaseEpoch: prior.databaseEpoch, repeated: true };
    }
    // Refuse partial installations or non-Prisma date storage. Never coerce source rows.
    const names = await db.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE name IN ('PaintHour','PaintSegment','PaintCommandReceipt','PaintMutation','QuarterWorldRevision')");
    if (names.length) throw new QuarterRefused("QUARTER_PARTIAL_SCHEMA", 503);
    const invalid = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) n FROM Shift WHERE typeof(startAt)<>'integer' OR typeof(endAt)<>'integer' OR (supersededAt IS NOT NULL AND typeof(supersededAt)<>'integer')`);
    if (Number(invalid[0].n)) throw new QuarterRefused("QUARTER_SOURCE_STORAGE_INCOMPATIBLE", 503);
    const databaseEpoch = randomUUID();
    for (const sql of QUARTER_MIGRATION.filter(s => !s.startsWith("CREATE TRIGGER"))) await db.$executeRawUnsafe(sql);
    await db.$executeRawUnsafe("INSERT INTO QuarterSchema VALUES (1,2,'prepared',?,1,1,?,NULL)", databaseEpoch, MIGRATION_SHA256);
    await db.$executeRawUnsafe("INSERT INTO QuarterWorldRevision VALUES (1,0)");
    for (const sql of QUARTER_MIGRATION.filter(s => s.startsWith("CREATE TRIGGER"))) await db.$executeRawUnsafe(sql);
    await verifyQuarterSchema(db);
    return { databaseEpoch, repeated: false };
  }, { timeout: 30_000, maxWait: 10_000 });
}

/** Foundation deliberately cannot authorize activation or claim to be the recovery artifact. */
export const FOUNDATION_CAPABILITIES = Object.freeze({ protocol: 2, artifactRole: "foundation", activation: false,
  recovery: false, quarterUi: false, blockNotes: false, maxHours: 500, maxIntents: 2000, maxBytes: 2 * 1024 * 1024 });
export const CAPABILITY_SHA256 = digest(FOUNDATION_CAPABILITIES);
