import { describe, expect, it } from "vitest";
import { CAJA_STATIONS, COCINA_STATIONS, ALL_STATIONS } from "@/lib/stations";
import { boardConfig, loadStationsForBoard } from "@/lib/board-config";
import { KITCHEN_TAREA_TEMPLATES } from "@/lib/tareas/catalog";

describe("station seed dictionaries", () => {
  it("seeds all caja stations from SPEC §4.4", () => {
    expect(CAJA_STATIONS.map((s) => s.id)).toEqual([
      "mana",
      "green1",
      "yellow",
      "purple1",
      "green2",
      "blue",
      "purple2",
      "multi",
      "nieves",
      "mesero",
      "clean",
    ]);
    const nieves = CAJA_STATIONS.find((s) => s.id === "nieves");
    expect(nieves?.maxConcurrent).toBe(1);
  });

  it("seeds cocina stations from Kitchen seed (six stations, max=1)", () => {
    expect(COCINA_STATIONS.map((s) => s.id)).toEqual([
      "fryer",
      "tortilla",
      "birria",
      "taquero",
      "carne",
      "prepa",
    ]);
    for (const s of COCINA_STATIONS) {
      expect(s.maxConcurrent).toBe(1);
    }
  });

  it("has unique station ids across boards", () => {
    const ids = ALL_STATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes board-config hooks for both boards", () => {
    expect(boardConfig("cocina").stations).toHaveLength(6);
    expect(loadStationsForBoard("cocina").map((s) => s.id)).toEqual([
      "fryer",
      "tortilla",
      "birria",
      "taquero",
      "carne",
      "prepa",
    ]);
    expect(KITCHEN_TAREA_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(boardConfig("caja").multiSeatId).toBe("multi");
    expect(boardConfig("cocina").multiSeatId).toBeNull();
  });
});
