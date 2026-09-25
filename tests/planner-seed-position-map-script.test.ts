/**
 * Planner G — scripts/seed-position-map.ts is the installer's own entry
 * point (never prisma/seed.ts's full demo seed) against the live database.
 * It must touch only PositionStationMap rows, and be idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-position-map-"));
const dbUrl = `file:${path.join(tmp, "seed-map.db")}`;
const env = { ...process.env, DATABASE_URL: dbUrl };

function run(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });
}

describe("scripts/seed-position-map.ts", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    fs.writeFileSync(path.join(tmp, "seed-map.db"), "");
    run("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"]);
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes only PositionStationMap rows, and a second run adds nothing", async () => {
    // Only "mana" exists — mirrors a real board mid-rollout, where a
    // manager may not have added every mapped station yet.
    await prisma.station.create({
      data: {
        id: "mana",
        board: "caja",
        label: "MANA (Manager)",
        color: "pink",
        maxConcurrent: 1,
        sortOrder: 0,
      },
    });
    const employee = await prisma.employee.create({
      data: { externalId: "seed-script-emp", firstName: "K", lastName: "E" },
    });
    await prisma.employeeStationAbility.create({
      data: { employeeId: employee.id, stationId: "mana", level: "ok" },
    });
    const shift = await prisma.shift.create({
      data: {
        employeeId: employee.id,
        date: "2030-01-01",
        startAt: new Date("2030-01-01T15:00:00Z"),
        endAt: new Date("2030-01-01T19:00:00Z"),
        sourcePosition: "Caja Manager",
        board: "caja",
      },
    });
    await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId: employee.id,
        stationId: "mana",
        hourStart: new Date("2030-01-01T15:00:00Z"),
        hourEnd: new Date("2030-01-01T16:00:00Z"),
      },
    });

    const before = {
      stations: await prisma.station.count(),
      employees: await prisma.employee.count(),
      shifts: await prisma.shift.count(),
      assignments: await prisma.assignment.count(),
      abilities: await prisma.employeeStationAbility.count(),
    };

    const firstOutput = run("pnpm", ["exec", "tsx", "scripts/seed-position-map.ts"]);
    expect(firstOutput).toMatch(/seed map added=1 present=0 station-missing=4/);

    const after = {
      stations: await prisma.station.count(),
      employees: await prisma.employee.count(),
      shifts: await prisma.shift.count(),
      assignments: await prisma.assignment.count(),
      abilities: await prisma.employeeStationAbility.count(),
    };
    expect(after).toEqual(before);

    const mapRows = await prisma.positionStationMap.findMany();
    expect(mapRows).toHaveLength(1);
    expect(mapRows[0]!.position).toBe("Caja Manager");
    expect(mapRows[0]!.stationId).toBe("mana");

    // Existing employee/ability/assignment data is exactly as seeded — the
    // script did not touch any table but PositionStationMap.
    const ability = await prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId: employee.id, stationId: "mana" } },
    });
    expect(ability?.level).toBe("ok");

    const secondOutput = run("pnpm", ["exec", "tsx", "scripts/seed-position-map.ts"]);
    expect(secondOutput).toMatch(/seed map added=0 present=1 station-missing=4/);
    const mapRowsAfterSecond = await prisma.positionStationMap.findMany();
    expect(mapRowsAfterSecond).toHaveLength(1);
  }, 60_000);

  it("exits 0 on success", () => {
    expect(() => run("pnpm", ["exec", "tsx", "scripts/seed-position-map.ts"])).not.toThrow();
  });
});
