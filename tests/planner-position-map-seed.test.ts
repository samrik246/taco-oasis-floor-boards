import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";
import {
  POSITION_STATION_MAP_SEED,
  seedPositionStationMap,
} from "@/lib/assignments/position-map-seed";

const prisma = new PrismaClient();

// Planner G bootstrap: idempotent seed of the five known position->station
// keys (mana, nieves, mesero exist in the code seed; pdf_guia does not, so
// its two keys are expected to skip as station-missing here).
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

  it("seeds the three keys whose station exists, skips the two that don't", async () => {
    const result = await seedPositionStationMap(prisma);
    expect(result.added).toBe(3);
    expect(result.stationMissing).toBe(2);
    const rows = await prisma.positionStationMap.findMany();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.position).sort()).toEqual(
      ["Caja - Meser@", "Caja - Nieves", "Caja Manager"].sort(),
    );
  });

  it("running it twice leaves the same rows and writes nothing the second time", async () => {
    const first = await seedPositionStationMap(prisma);
    expect(first.added).toBe(3);
    const second = await seedPositionStationMap(prisma);
    expect(second.added).toBe(0);
    expect(second.stationMissing).toBe(2);
    const rows = await prisma.positionStationMap.findMany();
    expect(rows).toHaveLength(3);
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

  it("seeds all five keys once the missing stations exist", async () => {
    await prisma.station.upsert({
      where: { id: "pdf_guia" },
      create: {
        id: "pdf_guia",
        board: "cocina",
        label: "Guía",
        color: "gray",
        maxConcurrent: 1,
        sortOrder: 99,
        priority: null,
      },
      update: {},
    });
    const result = await seedPositionStationMap(prisma);
    expect(result.added).toBe(POSITION_STATION_MAP_SEED.length);
    expect(result.stationMissing).toBe(0);
    const rows = await prisma.positionStationMap.findMany();
    expect(rows).toHaveLength(5);
    await prisma.station.delete({ where: { id: "pdf_guia" } });
  });
});
