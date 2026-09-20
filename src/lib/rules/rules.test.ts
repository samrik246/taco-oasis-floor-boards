import { describe, expect, it } from "vitest";
import { isHourInShift } from "@/lib/rules/shift-window";
import { canOccupyStation, isStackableStation } from "@/lib/rules/uniqueness";
import {
  seedAbilitiesFromPositions,
  isAbilityBlocking,
  abilitySortRank,
} from "@/lib/rules/abilities";
import { validateAssignment } from "@/lib/rules/assign";
import { chicagoDateTime } from "@/lib/time";

describe("shift window (SPEC §4.1)", () => {
  const start = chicagoDateTime("2026-09-20", "8:00 am");
  const end = chicagoDateTime("2026-09-20", "5:00 pm");

  it("allows hour at inclusive start", () => {
    expect(isHourInShift(chicagoDateTime("2026-09-20", "8:00 am"), start, end)).toBe(
      true,
    );
  });

  it("allows mid-shift hour", () => {
    expect(isHourInShift(chicagoDateTime("2026-09-20", "12:00 pm"), start, end)).toBe(
      true,
    );
  });

  it("rejects hour at exclusive end", () => {
    expect(isHourInShift(chicagoDateTime("2026-09-20", "5:00 pm"), start, end)).toBe(
      false,
    );
  });

  it("rejects hour before start", () => {
    expect(isHourInShift(chicagoDateTime("2026-09-20", "7:00 am"), start, end)).toBe(
      false,
    );
  });
});

describe("station uniqueness (SPEC §4.2)", () => {
  it("rejects second occupant when maxConcurrent=1 (green1)", () => {
    expect(
      canOccupyStation({ maxConcurrent: 1, existingOccupancy: 1 }),
    ).toBe(false);
  });

  it("allows first occupant on maxConcurrent=1", () => {
    expect(
      canOccupyStation({ maxConcurrent: 1, existingOccupancy: 0 }),
    ).toBe(true);
  });

  it("rejects second occupant on nieves (Phase 1: no stacking)", () => {
    expect(isStackableStation(1)).toBe(false);
    expect(
      canOccupyStation({ maxConcurrent: 1, existingOccupancy: 1 }),
    ).toBe(false);
  });

  it("legacy unlimited helper still works for maxConcurrent=-1", () => {
    expect(isStackableStation(-1)).toBe(true);
    expect(
      canOccupyStation({ maxConcurrent: -1, existingOccupancy: 5 }),
    ).toBe(true);
  });

  it("allows two on linea (maxConcurrent=2) but not three", () => {
    expect(
      canOccupyStation({ maxConcurrent: 2, existingOccupancy: 1 }),
    ).toBe(true);
    expect(
      canOccupyStation({ maxConcurrent: 2, existingOccupancy: 2 }),
    ).toBe(false);
  });

  it("reservingSlot frees one slot for update-in-place", () => {
    expect(
      canOccupyStation({
        maxConcurrent: 1,
        existingOccupancy: 1,
        reservingSlot: true,
      }),
    ).toBe(true);
  });
});

describe("abilities seed + block (SPEC §4.3 / §4.7)", () => {
  it("seeds preferred mana for Caja Manager and forbids cocina", () => {
    const seeds = seedAbilitiesFromPositions(["Caja Manager"]);
    expect(seeds.find((s) => s.stationId === "mana")?.level).toBe("preferred");
    expect(seeds.find((s) => s.stationId === "green1")?.level).toBe("ok");
    expect(seeds.find((s) => s.stationId === "linea")?.level).toBe("forbidden");
  });

  it("seeds preferred nieves for Caja - Nieves", () => {
    const seeds = seedAbilitiesFromPositions(["Caja - Nieves"]);
    expect(seeds.find((s) => s.stationId === "nieves")?.level).toBe("preferred");
  });

  it("seeds training green1 for Caja - Prueba", () => {
    const seeds = seedAbilitiesFromPositions(["Caja - Prueba"]);
    expect(seeds.find((s) => s.stationId === "green1")?.level).toBe("training");
  });

  it("seeds mesero preferred for Meser@", () => {
    const seeds = seedAbilitiesFromPositions(["Caja - Meser@"]);
    expect(seeds.find((s) => s.stationId === "mesero")?.level).toBe("preferred");
  });

  it("blocks forbidden abilities", () => {
    expect(isAbilityBlocking("forbidden")).toBe(true);
    expect(isAbilityBlocking("ok")).toBe(false);
    expect(isAbilityBlocking(null)).toBe(false);
  });

  it("sorts preferred before forbidden", () => {
    expect(abilitySortRank("preferred")).toBeLessThan(abilitySortRank("ok"));
    expect(abilitySortRank("ok")).toBeLessThan(abilitySortRank("training"));
    expect(abilitySortRank("training")).toBeLessThan(abilitySortRank("forbidden"));
  });
});

describe("validateAssignment composed rules", () => {
  const base = {
    hourStart: chicagoDateTime("2026-09-20", "10:00 am"),
    shiftStart: chicagoDateTime("2026-09-20", "8:00 am"),
    shiftEnd: chicagoDateTime("2026-09-20", "5:00 pm"),
    stationId: "green1",
    stationBoard: "caja",
    shiftBoard: "caja",
    maxConcurrent: 1,
    existingOccupancy: 0,
    abilityLevel: "ok" as const,
    personAlreadyAssignedAtHour: false,
    chicagoHour: 10,
  };

  it("passes a valid assign", () => {
    expect(validateAssignment(base)).toEqual([]);
  });

  it("rejects double green1", () => {
    const v = validateAssignment({ ...base, existingOccupancy: 1 });
    expect(v.some((x) => x.code === "STATION_FULL")).toBe(true);
  });

  it("rejects second nieves occupant (no stacking)", () => {
    const v = validateAssignment({
      ...base,
      stationId: "nieves",
      maxConcurrent: 1,
      existingOccupancy: 1,
    });
    expect(v.some((x) => x.code === "STATION_FULL")).toBe(true);
  });

  it("rejects out-of-shift", () => {
    const v = validateAssignment({
      ...base,
      hourStart: chicagoDateTime("2026-09-20", "6:00 pm"),
      chicagoHour: 18,
    });
    expect(v.some((x) => x.code === "OUT_OF_SHIFT")).toBe(true);
  });

  it("rejects forbidden ability", () => {
    const v = validateAssignment({ ...base, abilityLevel: "forbidden" });
    expect(v.some((x) => x.code === "FORBIDDEN_ABILITY")).toBe(true);
  });
});
