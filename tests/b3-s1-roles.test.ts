/**
 * B3 S1 roles: owner gate, last-owner 409, unlock idle, set-owner, schema upgrade.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET as listManagers, POST as createManager } from "@/app/api/admin/managers/route";
import { DELETE as deleteManager, PATCH as patchManager } from "@/app/api/admin/managers/[id]/route";
import { GET as managerConfig, POST as managerLogin } from "@/app/api/managers/route";
import { deleteManagerAccess, updateManagerAccess } from "@/lib/managers/admin-mutate";
import {
  OWNER_IDLE_MS,
  hashManagerCode,
  managerIdleMsFor,
} from "@/lib/managers/codes";
import { MANAGER_SESSION_TTL_MS, signManagerSession } from "@/lib/managers/session";

const prisma = new PrismaClient();
const stamp = `B3S1-${Date.now()}`;
const root = process.cwd();
const schemaHash = "4a0f840fd09db5236fc4bb1e41582f6c6d6319b04823627e3def6cc4987c665d";

function authed(token: string | null, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (token) headers.set("x-manager-session", token);
  return new Request(url, { ...init, headers });
}

async function make(label: string, role: string, active = true) {
  return prisma.manager.create({
    data: {
      name: `${stamp} ${label}`,
      codeHash: hashManagerCode(`${stamp}-${label}`),
      active,
      role,
    },
  });
}

function tokenFor(manager: { id: string; name: string }) {
  return signManagerSession({ id: manager.id, name: manager.name });
}

async function patch(token: string | null, id: string, body: Record<string, unknown>) {
  return patchManager(
    authed(token, `http://local/api/admin/managers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function remove(token: string | null, id: string) {
  return deleteManager(
    authed(token, `http://local/api/admin/managers/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
}

describe("B3 S1 owner role", () => {
  afterAll(async () => {
    await prisma.manager.deleteMany({ where: { name: { startsWith: stamp } } });
    await prisma.$disconnect();
  });

  it("A10 production owner idle is the constant 300000 and beats longIdle and the env", () => {
    expect(OWNER_IDLE_MS).toBe(300_000);
    expect(managerIdleMsFor({ longIdle: true, role: "owner" }, { MANAGER_IDLE_MS: "1500" })).toBe(300_000);
    expect(managerIdleMsFor({ longIdle: true, role: "Owner" })).toBe(600_000);
    expect(managerIdleMsFor({ longIdle: false, role: "manager" }, {})).toBe(15_000);
  });

  it("A1 owner route matrix is 401, 403, then 200", async () => {
    const owner = await make("GateOwner", "owner");
    const manager = await make("GateManager", "manager");
    const ownerToken = tokenFor(owner);
    const managerToken = tokenFor(manager);
    const createdName = `${stamp} Created`;
    const cases = [
      {
        name: "GET",
        run: (token: string | null) => listManagers(authed(token, "http://local/api/admin/managers")),
        ownerStatus: 200,
      },
      {
        name: "POST",
        run: (token: string | null) =>
          createManager(
            authed(token, "http://local/api/admin/managers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: createdName, code: "9753", role: "owner" }),
            }),
          ),
        ownerStatus: 200,
      },
    ] as const;

    for (const entry of cases) {
      expect((await entry.run(null)).status, entry.name).toBe(401);
      expect((await entry.run(managerToken)).status, entry.name).toBe(403);
      expect((await entry.run(ownerToken)).status, entry.name).toBe(entry.ownerStatus);
    }

    const created = await prisma.manager.findFirstOrThrow({ where: { name: createdName } });
    expect(created.role).toBe("manager");

    const patchUrl = created.id;
    expect((await patch(null, patchUrl, { active: true })).status).toBe(401);
    expect((await patch(managerToken, patchUrl, { active: true })).status).toBe(403);
    expect((await patch(ownerToken, patchUrl, { longIdle: true })).status).toBe(200);

    const doomed = await make("Doomed", "manager");
    expect((await remove(null, doomed.id)).status).toBe(401);
    expect((await remove(managerToken, doomed.id)).status).toBe(403);
    expect((await remove(ownerToken, doomed.id)).status).toBe(200);
    expect(await prisma.manager.findUnique({ where: { id: doomed.id } })).toBeNull();
  });

  it("A2 demoting an owner takes effect on the next request with the same token", async () => {
    const owner = await make("Demote", "owner");
    await make("DemoteKeep", "owner");
    const same = tokenFor(owner);
    expect((await listManagers(authed(same, "http://local/api/admin/managers"))).status).toBe(200);
    expect((await patch(same, owner.id, { role: "manager" })).status).toBe(200);
    const next = await listManagers(authed(same, "http://local/api/admin/managers"));
    expect(next.status).toBe(403);
    expect(await next.json()).toEqual({ error: "Owner code required" });
    const payload = JSON.parse(Buffer.from(same.split(".")[0]!, "base64url").toString("utf8")) as {
      role?: string;
      exp: number;
    };
    expect(payload).not.toHaveProperty("role");
    expect(payload.exp - Date.now()).toBeGreaterThan(MANAGER_SESSION_TTL_MS - 5_000);
    expect(payload.exp - Date.now()).toBeLessThanOrEqual(MANAGER_SESSION_TTL_MS);
  });

  it("A3 last owner is 409 and a second owner makes the same write 200; 422 stays", async () => {
    const owner = await make("Last", "owner");
    const parked = await prisma.manager.findMany({
      where: { active: true, role: "owner", NOT: { id: owner.id } },
      select: { id: true },
    });
    const ownerToken = tokenFor(owner);
    if (parked.length) {
      await prisma.manager.updateMany({
        where: { id: { in: parked.map((row) => row.id) } },
        data: { role: "manager" },
      });
    }
    try {
      expect((await patch(ownerToken, owner.id, { role: "manager" })).status).toBe(409);
      expect((await patch(ownerToken, owner.id, { active: false })).status).toBe(409);
      expect((await remove(ownerToken, owner.id)).status).toBe(409);
      expect((await prisma.manager.findUniqueOrThrow({ where: { id: owner.id } })).role).toBe("owner");

      const second = await make("Second", "owner");
      expect((await patch(ownerToken, owner.id, { role: "manager" })).status).toBe(200);
      const third = await make("Third", "owner");
      expect((await patch(tokenFor(third), second.id, { active: false })).status).toBe(200);
      const fourth = await make("Fourth", "owner");
      expect((await remove(tokenFor(third), fourth.id)).status).toBe(200);
    } finally {
      if (parked.length) {
        await prisma.manager.updateMany({
          where: { id: { in: parked.map((row) => row.id) } },
          data: { role: "owner" },
        });
      }
    }
  });

  it("the last-active-manager 422 still refuses a non-owner when they are the only active row", async () => {
    const keeper = await make("Keeper", "manager");
    const parked = await prisma.manager.findMany({
      where: { active: true, NOT: { id: keeper.id } },
      select: { id: true },
    });
    if (parked.length) {
      await prisma.manager.updateMany({
        where: { id: { in: parked.map((row) => row.id) } },
        data: { active: false },
      });
    }
    try {
      const result = await updateManagerAccess(keeper.id, { active: false });
      expect(result).toMatchObject({ ok: false, status: 422 });
      const removed = await deleteManagerAccess(keeper.id);
      expect(removed).toMatchObject({ ok: false, status: 422 });
      expect((await prisma.manager.findUniqueOrThrow({ where: { id: keeper.id } })).active).toBe(true);
    } finally {
      if (parked.length) {
        await prisma.manager.updateMany({
          where: { id: { in: parked.map((row) => row.id) } },
          data: { active: true },
        });
      }
    }
  });

  it("A4 unlock idle comes from the row, never the request body, and a non-owner role fails closed", async () => {
    const owner = await make("IdleOwner", "owner");
    await prisma.manager.update({ where: { id: owner.id }, data: { longIdle: true } });
    const longManager = await make("IdleLong", "manager");
    await prisma.manager.update({ where: { id: longManager.id }, data: { longIdle: true } });
    const plain = await make("IdlePlain", "manager");
    const weird = await make("IdleWeird", "OWNER");

    async function unlock(code: string, extra: Record<string, unknown> = {}) {
      const res = await managerLogin(
        new Request("http://local/api/managers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, ...extra }),
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { idleMs: number; manager: { role: string }; sessionToken: string };
    }

    const ownerBody = await unlock(`${stamp}-IdleOwner`, { role: "manager", idleMs: 5 });
    expect(ownerBody.idleMs).toBe(300_000);
    expect(ownerBody.manager.role).toBe("owner");
    const claims = JSON.parse(Buffer.from(ownerBody.sessionToken.split(".")[0]!, "base64url").toString("utf8")) as {
      role?: string;
    };
    expect(claims).not.toHaveProperty("role");

    expect((await unlock(`${stamp}-IdleLong`, { role: "owner", idleMs: 1 })).idleMs).toBe(600_000);
    expect((await unlock(`${stamp}-IdlePlain`)).idleMs).toBe(15_000);
    expect((await unlock(`${stamp}-IdleWeird`)).manager.role).toBe("OWNER");
    expect((await listManagers(authed(tokenFor(weird), "http://local/api/admin/managers"))).status).toBe(403);

    const config = await managerConfig();
    expect(await config.json()).toEqual({ idleMs: 15_000 });
  });
});

describe("B3 S1 set-owner and upgrade from 82589fc", () => {
  function disposable(name: string) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const dbUrl = `file:${path.join(tmp, "home-base.db")}`;
    const env = { ...process.env, DATABASE_URL: dbUrl };
    const run = (args: string[]) =>
      execFileSync("pnpm", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });
    return { tmp, dbUrl, env, run };
  }

  function script(env: NodeJS.ProcessEnv, args: string[]) {
    return execFileSync("pnpm", ["exec", "tsx", "scripts/set-owner.ts", ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: "pipe",
    });
  }

  it("A5 set-owner refuses an unknown or inactive id and prints id plus role only", async () => {
    const { tmp, env, run } = disposable("b3-set-owner");
    const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    try {
      run(["exec", "prisma", "db", "push", "--skip-generate"]);
      const hash = hashManagerCode("s1-host-code");
      const row = await db.manager.create({
        data: { name: "S1 Host Owner", codeHash: hash, active: true, role: "manager" },
      });
      const inactive = await db.manager.create({
        data: { name: "S1 Host Inactive", codeHash: hash, active: false, role: "manager" },
      });
      await db.$disconnect();

      expect(() => script(env, ["--manager-id", "missing-id"])).toThrow();
      try {
        script(env, ["--manager-id", "missing-id"]);
      } catch (error) {
        const err = error as { status: number; stderr: string; stdout: string };
        expect(err.status).not.toBe(0);
        expect(`${err.stderr}`).toMatch(/unknown manager/);
        expect(`${err.stdout ?? ""}${err.stderr}`).not.toMatch(/S1 Host/);
      }
      expect(() => script(env, ["--manager-id", inactive.id])).toThrow();

      const stdout = script(env, ["--manager-id", row.id]);
      expect(stdout.trim()).toBe(`${row.id} owner`);
      expect(stdout).not.toMatch(/S1 Host|s1-host-code/);
      const check = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
      const updated = await check.manager.findUniqueOrThrow({ where: { id: row.id } });
      expect(updated.role).toBe("owner");
      await check.$disconnect();
    } finally {
      await db.$disconnect().catch(() => undefined);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("A6 db push from 82589fc adds role manager without data loss", async () => {
    const { tmp, env, run } = disposable("b3-upgrade");
    const oldSchema = fs.readFileSync(path.join(root, "tests", "fixtures", "schema-82589fc.prisma"), "utf8");
    expect(createHash("sha256").update(oldSchema).digest("hex")).toBe(schemaHash);
    expect(oldSchema).not.toContain('role      String   @default("manager")');
    const schemaPath = path.join(tmp, "schema.prisma");
    fs.writeFileSync(schemaPath, oldSchema);
    fs.writeFileSync(path.join(tmp, "home-base.db"), "");
    const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    try {
      run(["exec", "prisma", "db", "push", "--schema", schemaPath, "--skip-generate"]);
      const hash = hashManagerCode("2468");
      await db.$executeRawUnsafe(
        `INSERT INTO "Manager" (id, name, codeHash, active, longIdle, createdAt, updatedAt) VALUES ('m-legacy','S1 Legacy','${hash}',1,0,0,0)`,
      );
      const before = await db.$queryRawUnsafe<Array<{ n: number | bigint }>>(
        `SELECT COUNT(*) as n FROM "Manager"`,
      );
      await db.$disconnect();
      const push = run(["exec", "prisma", "db", "push", "--skip-generate"]);
      expect(push).toMatch(/in sync/i);
      const after = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
      const rows = await after.$queryRawUnsafe<Array<{ id: string; codeHash: string; role: string }>>(
        `SELECT id, codeHash, role FROM "Manager"`,
      );
      expect(rows).toEqual([{ id: "m-legacy", codeHash: hash, role: "manager" }]);
      const count = await after.$queryRawUnsafe<Array<{ n: number | bigint }>>(
        `SELECT COUNT(*) as n FROM "Manager"`,
      );
      expect(Number(count[0]?.n)).toBe(Number(before[0]?.n));
      const table = await after.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'BoardChangeLog'`,
      );
      expect(table).toHaveLength(1);
      await after.$disconnect();
    } finally {
      await db.$disconnect().catch(() => undefined);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("upgrade-home-base prepare adds the role column for an 82589fc database", async () => {
    const { tmp, env, run } = disposable("b3-prepare");
    const schemaPath = path.join(tmp, "schema.prisma");
    fs.writeFileSync(schemaPath, fs.readFileSync(path.join(root, "tests", "fixtures", "schema-82589fc.prisma")));
    fs.writeFileSync(path.join(tmp, "home-base.db"), "");
    const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    try {
      run(["exec", "prisma", "db", "push", "--schema", schemaPath, "--skip-generate"]);
      await db.$executeRawUnsafe(
        `INSERT INTO "Manager" (id, name, codeHash, active, longIdle, createdAt, updatedAt) VALUES ('m-prep','S1 Prep','abc',1,0,0,0)`,
      );
      await db.$disconnect();
      run(["exec", "tsx", "scripts/upgrade-home-base.ts", "prepare"]);
      const after = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
      const rows = await after.$queryRawUnsafe<Array<{ id: string; role: string; name: string }>>(
        `SELECT id, name, role FROM "Manager"`,
      );
      expect(rows).toEqual([{ id: "m-prep", name: "S1 Prep", role: "manager" }]);
      await after.$disconnect();
    } finally {
      await db.$disconnect().catch(() => undefined);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
