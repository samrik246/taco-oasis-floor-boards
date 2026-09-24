/**
 * A18: the install path (scripts/remote-deploy.sh:162-166) upgrades a
 * d02d812-shaped database with rows without data loss, and re-running it after
 * C1 re-imports keeps every stored fingerprint.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c1-a18-"));
const dbUrl = `file:${path.join(tmp, "home-base.db")}`;
const env = { ...process.env, DATABASE_URL: dbUrl };

function run(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });
}

const T = (iso: string) => new Date(iso).getTime();

describe("A18: schema upgrade from d02d812 keeps every row", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    // The d02d812 schema, byte for byte, from git.
    const oldSchema = execFileSync("git", ["show", "d02d812:prisma/schema.prisma"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(oldSchema).not.toContain("supersededAt");
    const schemaPath = path.join(tmp, "schema.prisma");
    fs.writeFileSync(schemaPath, oldSchema);
    // Start from an empty file, as a first install does (some hosts' schema engine will not create one).
    fs.writeFileSync(path.join(tmp, "home-base.db"), "");
    run("pnpm", ["exec", "prisma", "db", "push", "--schema", schemaPath, "--skip-generate"]);
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("db push without --accept-data-loss succeeds; rows survive; new columns are null", async () => {
    const x = prisma.$executeRawUnsafe.bind(prisma);
    await x(`INSERT INTO "Station" (id, board, label, color, maxConcurrent, sortOrder, priority, shortCode) VALUES ('green1','caja','Green 1','green',1,1,1,'')`);
    await x(`INSERT INTO "Employee" (id, externalId, firstName, lastName, email, createdAt, updatedAt) VALUES ('emp1','0042','Kira','Ejemplo',NULL,${T("2030-09-01T00:00:00Z")},${T("2030-09-01T00:00:00Z")})`);
    await x(`INSERT INTO "ImportBatch" (id, filename, fingerprint, importedAt, rowCount) VALUES ('b1','m.csv','${"a".repeat(64)}',${T("2030-09-01T12:00:00Z")},1)`);
    await x(`INSERT INTO "Shift" (id, employeeId, date, startAt, endAt, sourcePosition, board, importBatchId) VALUES ('s1','emp1','2030-09-02',${T("2030-09-02T13:00:00Z")},${T("2030-09-02T21:00:00Z")},'Caja - Regular','caja','b1')`);
    await x(`INSERT INTO "Assignment" (id, shiftId, employeeId, stationId, hourStart, hourEnd) VALUES ('a1','s1','emp1','green1',${T("2030-09-02T14:00:00Z")},${T("2030-09-02T15:00:00Z")})`);
    const before = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT s.id, s.startAt, s.endAt, a.id AS aid, e.externalId, b.fingerprint FROM "Shift" s JOIN "Assignment" a ON a.shiftId = s.id JOIN "Employee" e ON e.id = s.employeeId JOIN "ImportBatch" b ON b.id = s.importBatchId`,
    );

    // The install sequence, in order (remote-deploy.sh:162-166).
    for (const mode of ["preflight", "prepare", "backfill", "enforce"]) {
      run("pnpm", ["exec", "tsx", "scripts/upgrade-home-base.ts", mode]);
    }
    const push = run("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"]);
    expect(push).toMatch(/in sync/);

    const after = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT s.id, s.startAt, s.endAt, a.id AS aid, e.externalId, b.fingerprint FROM "Shift" s JOIN "Assignment" a ON a.shiftId = s.id JOIN "Employee" e ON e.id = s.employeeId JOIN "ImportBatch" b ON b.id = s.importBatchId`,
    );
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const cols = await prisma.$queryRawUnsafe<Array<{ name: string; notnull: bigint | number }>>(`PRAGMA table_info("Shift")`);
    for (const name of ["supersededAt", "supersededByBatchId"]) {
      const col = cols.find((c) => c.name === name);
      expect(col, name).toBeTruthy();
      expect(Number(col!.notnull), name).toBe(0);
    }
    const nulls = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM "Shift" WHERE supersededAt IS NULL AND supersededByBatchId IS NULL`,
    );
    expect(Number(nulls[0]!.n)).toBe(1);
  }, 120_000);

  it("re-running the install after C1 re-imports keeps stored fingerprints (no recompute, no collision)", async () => {
    const x = prisma.$executeRawUnsafe.bind(prisma);
    // Two afternoon batches that only changed times: no shifts link to them.
    await x(`INSERT INTO "ImportBatch" (id, filename, fingerprint, importedAt, rowCount) VALUES ('b2','a1.csv','${"b".repeat(64)}',${T("2030-09-02T20:00:00Z")},1)`);
    await x(`INSERT INTO "ImportBatch" (id, filename, fingerprint, importedAt, rowCount) VALUES ('b3','a2.csv','${"c".repeat(64)}',${T("2030-09-02T21:00:00Z")},1)`);
    for (const mode of ["preflight", "prepare", "backfill", "enforce"]) {
      run("pnpm", ["exec", "tsx", "scripts/upgrade-home-base.ts", mode]);
    }
    run("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"]);
    const batches = await prisma.$queryRawUnsafe<Array<{ id: string; fingerprint: string }>>(
      `SELECT id, fingerprint FROM "ImportBatch" ORDER BY id`,
    );
    expect(batches).toEqual([
      { id: "b1", fingerprint: "a".repeat(64) },
      { id: "b2", fingerprint: "b".repeat(64) },
      { id: "b3", fingerprint: "c".repeat(64) },
    ]);
  }, 120_000);
});
