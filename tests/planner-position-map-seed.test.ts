import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";
import {
  POSITION_STATION_MAP_SEED,
  seedPositionStationMap,
} from "@/lib/assignments/position-map-seed";

const prisma = new PrismaClient();

// Planner G bootstrap: all five known position->station keys now have seeded
// stations, including the retained Cocina Guía seat.
describe("seedPositionStationMap", () => {
  beforeAll(async () => {
    for (const s of ALL_STATIONS) {
      await prisma.station.upsert({
        where: { id: s.id },
        create: {
          id: s.id,
          board: s.board,
          label: s.label,
          color: s.color,
          maxConcurrent: s.maxConcurrent,
          sortOrder: s.sortOrder,
          priority: s.priority,
        },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.positionStationMap.deleteMany();
  });

  it("seeds all five keys against the current station set", async () => {
    const result = await seedPositionStationMap(prisma);
    expect(result.added).toBe(POSITION_STATION_MAP_SEED.length);
    expect(result.stationMissing).toBe(0);
    const rows = await prisma.positionStationMap.findMany();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.position).sort()).toEqual(
      ["Caja - Meser@", "Caja - Nieves", "Caja Manager", "Cocina Guia Abrir", "Cocina Guia Cerrar"].sort(),
    );
  });

  it("running it twice leaves the same rows and writes nothing the second time", async () => {
    const first = await seedPositionStationMap(prisma);
    expect(first.added).toBe(5);
    const second = await seedPositionStationMap(prisma);
    expect(second.added).toBe(0);
    expect(second.stationMissing).toBe(0);
    const rows = await prisma.positionStationMap.findMany();
    expect(rows).toHaveLength(5);
  });

  it("a pre-cleared key (stationId set to null) stays null on a reseed", async () => {
    await seedPositionStationMap(prisma);
    await prisma.positionStationMap.update({
      where: { position: "Caja Manager" },
      data: { stationId: null },
    });
    await seedPositionStationMap(prisma);
    const row = await prisma.positionStationMap.findUnique({
      where: { position: "Caja Manager" },
    });
    expect(row?.stationId).toBeNull();
  });

  it("maps both Cocina Guía positions to the retained Cocina seat", async () => {
    await seedPositionStationMap(prisma);
    const rows = await prisma.positionStationMap.findMany({
      where: { position: { in: ["Cocina Guia Abrir", "Cocina Guia Cerrar"] } },
      orderBy: { position: "asc" },
    });
    expect(rows.map((row) => row.stationId)).toEqual(["pdf_guia", "pdf_guia"]);
    const station = await prisma.station.findUniqueOrThrow({ where: { id: "pdf_guia" } });
    expect(station.board).toBe("cocina");
  });

  it("skips missing Guía targets and preserves a manager-cleared mapping", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "position-map-missing-"));
    const dbUrl = `file:${path.join(root, "missing.db")}`;
    fs.writeFileSync(path.join(root, "missing.db"), "");
    let isolated: PrismaClient | undefined;
    try {
      execFileSync("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "pipe",
      });
      isolated = new PrismaClient({ datasources: { db: { url: dbUrl } } });
      await isolated.station.createMany({
        data: ALL_STATIONS.filter((station) => ["mana", "nieves", "mesero"].includes(station.id)),
      });
      await isolated.positionStationMap.create({
        data: { position: "Caja - Nieves", stationId: null },
      });

      const result = await seedPositionStationMap(isolated);
      expect(result).toEqual({ added: 2, stationMissing: 2 });
      const rows = await isolated.positionStationMap.findMany({ orderBy: { position: "asc" } });
      expect(rows.map(({ position, stationId }) => ({ position, stationId }))).toEqual([
        { position: "Caja - Meser@", stationId: "mesero" },
        { position: "Caja - Nieves", stationId: null },
        { position: "Caja Manager", stationId: "mana" },
      ]);
    } finally {
      await isolated?.$disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

});
