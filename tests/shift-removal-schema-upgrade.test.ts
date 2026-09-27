/** Upgrade a populated, disposable database from the accepted pre-feature schema. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "color-boards-test-removal-upgrade-"));
const dbUrl = `file:${path.join(temp, "home-base.db")}`;
const env = { ...process.env, DATABASE_URL: dbUrl };
const at = (iso: string) => new Date(iso).getTime();

function push(schema?: string) {
  return execFileSync("pnpm", ["exec", "prisma", "db", "push",
    ...(schema ? ["--schema", schema] : []), "--skip-generate"],
  { cwd: root, env, encoding: "utf8", stdio: "pipe" });
}

describe("manager removal schema upgrade on a disposable accepted-base database", () => {
  let db: PrismaClient;

  beforeAll(() => {
    const oldSchema = fs.readFileSync(path.join(root, "tests/fixtures/schema-9d66f10.prisma"), "utf8");
    expect(createHash("sha256").update(oldSchema).digest("hex")).toBe(
      "f63fb9b604359b83eb49d05f86fdba0b79046b7ee6265349dc8dc3315be269e1",
    );
    expect(oldSchema).not.toContain("boardRemoved");
    const schemaPath = path.join(temp, "schema.prisma");
    fs.writeFileSync(schemaPath, oldSchema);
    fs.writeFileSync(path.join(temp, "home-base.db"), "");
    push(schemaPath);
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("adds the visibility default and audit tables without changing stored rows", async () => {
    const write = db.$executeRawUnsafe.bind(db);
    await write(`INSERT INTO "Station" (id, board, label, color, maxConcurrent, sortOrder, priority, shortCode)
      VALUES ('green1','caja','Green 1','green',1,1,1,'G1')`);
    await write(`INSERT INTO "Employee" (id, externalId, firstName, lastName, createdAt, updatedAt)
      VALUES ('employee1','5201','Abril','Ejemplo',${at("2030-06-01T00:00:00Z")},${at("2030-06-01T00:00:00Z")})`);
    await write(`INSERT INTO "ImportBatch" (id, filename, fingerprint, importedAt, rowCount)
      VALUES ('batch1','schedule.csv','${"a".repeat(64)}',${at("2030-06-01T12:00:00Z")},1)`);
    await write(`INSERT INTO "Shift" (id, employeeId, date, startAt, endAt, sourcePosition, board, importBatchId)
      VALUES ('shift1','employee1','2030-06-03',${at("2030-06-03T13:00:00Z")},${at("2030-06-03T15:00:00Z")},'Caja - Regular','caja','batch1')`);
    await write(`INSERT INTO "Assignment" (id, shiftId, employeeId, stationId, hourStart, hourEnd)
      VALUES ('cell1','shift1','employee1','green1',${at("2030-06-03T13:00:00Z")},${at("2030-06-03T14:00:00Z")})`);

    const select = `SELECT s.id, s.employeeId, s.date, s.startAt, s.endAt, s.sourcePosition,
      s.board, s.importBatchId, a.id AS cellId, a.stationId, a.hourStart, a.hourEnd,
      e.externalId, b.fingerprint FROM "Shift" s
      JOIN "Assignment" a ON a.shiftId=s.id JOIN "Employee" e ON e.id=s.employeeId
      JOIN "ImportBatch" b ON b.id=s.importBatchId`;
    const before = await db.$queryRawUnsafe<unknown[]>(select);

    // This is the release schema operation, without --accept-data-loss.
    expect(push()).toMatch(/in sync/);
    expect(await db.$queryRawUnsafe<unknown[]>(select)).toEqual(before);
    const visibility = await db.$queryRawUnsafe<Array<{ id: string; boardRemoved: number | boolean }>>(
      `SELECT id, boardRemoved FROM "Shift"`,
    );
    expect(visibility.map((row) => ({ id: row.id, boardRemoved: Number(row.boardRemoved) })))
      .toEqual([{ id: "shift1", boardRemoved: 0 }]);
    for (const table of ["ShiftRemoval", "ShiftRemovalEvent"]) {
      const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
      );
      expect(rows.map((row) => row.name)).toEqual([table]);
    }
    expect(await db.$queryRawUnsafe<Array<{ integrity_check: string }>>(
      `PRAGMA integrity_check`,
    )).toEqual([{ integrity_check: "ok" }]);
    expect(await db.$queryRawUnsafe<unknown[]>(`PRAGMA foreign_key_check`)).toEqual([]);

    expect(push()).toMatch(/in sync/);
    expect(await db.$queryRawUnsafe<unknown[]>(select)).toEqual(before);
  }, 120_000);
});
