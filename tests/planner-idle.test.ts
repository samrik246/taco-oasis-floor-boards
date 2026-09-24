/**
 * Planner idle: one manager code can stay unlocked 10 minutes for a planning
 * session. The flag is set on Add manager; unlock returns the duration; the
 * public config and every other code keep the shared 15 seconds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { POST as createManager } from "@/app/api/admin/managers/route";
import { GET as managerConfig, POST as managerLogin } from "@/app/api/managers/route";
import {
  DEFAULT_MANAGER_IDLE_MS,
  LONG_MANAGER_IDLE_MS,
  hashManagerCode,
  managerIdleMsFromEnv,
} from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";

const prisma = new PrismaClient();
const stamp = Date.now();
const planner = { name: `Planner Idle ${stamp}`, code: `plan-${stamp}` };
const floor = { name: `Floor Idle ${stamp}`, code: `floor-${stamp}` };

async function adminToken() {
  const manager = await prisma.manager.create({
    data: { name: `Idle Admin ${stamp}`, codeHash: hashManagerCode(`admin-${stamp}`) },
  });
  return signManagerSession({ id: manager.id, name: manager.name });
}

async function add(token: string, body: Record<string, unknown>) {
  const res = await createManager(
    new Request("http://local/api/admin/managers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-manager-session": token },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { manager: { id: string; longIdle: boolean } };
}

async function unlock(body: Record<string, unknown>) {
  const res = await managerLogin(
    new Request("http://local/api/managers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { idleMs: number };
}

describe("planner idle: a per-code unlock timeout", () => {
  afterAll(async () => {
    await prisma.manager.deleteMany({ where: { name: { contains: String(stamp) } } });
    await prisma.$disconnect();
  });

  it("the shared setting is untouched: 15 seconds, MANAGER_IDLE_MS still overrides it", () => {
    expect(DEFAULT_MANAGER_IDLE_MS).toBe(15_000);
    expect(LONG_MANAGER_IDLE_MS).toBe(600_000);
    expect(managerIdleMsFromEnv({})).toBe(15_000);
    expect(managerIdleMsFromEnv({ MANAGER_IDLE_MS: "30000" })).toBe(30_000);
  });

  it("a code added with the box checked gets 600000 from unlock; the client cannot send a duration", async () => {
    const token = await adminToken();
    // A duration in the create body is ignored; only the flag is read.
    const created = await add(token, { ...planner, longIdle: true, idleMs: 1 });
    expect(created.manager.longIdle).toBe(true);
    const row = await prisma.manager.findUniqueOrThrow({ where: { id: created.manager.id } });
    expect(row.longIdle).toBe(true);

    // A duration in the unlock body is ignored too.
    expect((await unlock({ code: planner.code, idleMs: 5 })).idleMs).toBe(600_000);
  });

  it("a second manager on the same database, box unchecked, stays at 15000", async () => {
    const token = await adminToken();
    const created = await add(token, floor);
    expect(created.manager.longIdle).toBe(false);
    expect((await unlock({ code: floor.code })).idleMs).toBe(15_000);
    // The planner code is still long after the second manager exists.
    expect((await unlock({ code: planner.code })).idleMs).toBe(600_000);
  });

  it("GET /api/managers stays at 15000 while a long-idle code exists", async () => {
    expect(await prisma.manager.count({ where: { longIdle: true, active: true } })).toBeGreaterThan(0);
    const res = await managerConfig();
    expect(await res.json()).toEqual({ idleMs: 15_000 });
  });
});

describe("planner idle: upgrade from 7095442 keeps every manager at 15 seconds", () => {
  const root = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "planner-idle-"));
  const dbUrl = `file:${path.join(tmp, "home-base.db")}`;
  const env = { ...process.env, DATABASE_URL: dbUrl };
  let db: PrismaClient;

  const run = (args: string[]) =>
    execFileSync("pnpm", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });

  beforeAll(() => {
    // The installed 7095442 schema, pinned by hash (CI checks out one commit).
    const oldSchema = fs.readFileSync(path.join(root, "tests", "fixtures", "schema-7095442.prisma"), "utf8");
    expect(createHash("sha256").update(oldSchema).digest("hex")).toBe(
      "eb9179531bf0f31f2a59a5272d61efb82882f9f547a7f5d3eedad43b9858c658",
    );
    expect(oldSchema).not.toContain("longIdle");
    const schemaPath = path.join(tmp, "schema.prisma");
    fs.writeFileSync(schemaPath, oldSchema);
    fs.writeFileSync(path.join(tmp, "home-base.db"), "");
    run(["exec", "prisma", "db", "push", "--schema", schemaPath, "--skip-generate"]);
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("db push without --accept-data-loss adds the column off; the existing code keeps its hash", async () => {
    const hash = hashManagerCode("2468");
    await db.$executeRawUnsafe(
      `INSERT INTO "Manager" (id, name, codeHash, active, createdAt, updatedAt) VALUES ('m1','Ana Rivera','${hash}',1,0,0)`,
    );
    const push = run(["exec", "prisma", "db", "push", "--skip-generate"]);
    expect(push).toMatch(/in sync/);
    const rows = await db.$queryRawUnsafe<Array<{ id: string; codeHash: string; active: number; longIdle: number }>>(
      `SELECT id, codeHash, active, longIdle FROM "Manager"`,
    );
    expect(rows.map((r) => ({ ...r, active: Number(r.active), longIdle: Number(r.longIdle) }))).toEqual([
      { id: "m1", codeHash: hash, active: 1, longIdle: 0 },
    ]);
  }, 120_000);
});
