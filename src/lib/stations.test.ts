import { describe, expect, it } from "vitest";
import { CAJA_STATIONS, COCINA_STATIONS, ALL_STATIONS } from "@/lib/stations";
import { getBoardConfig } from "@/lib/board-config";
import { KITCHEN_LOAD_STATIONS } from "@/lib/load-stations";
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

  it("seeds cocina stations for Kitchen phase (six seats)", () => {
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

  it("board config exposes kitchen load map + tareas", () => {
    const cocina = getBoardConfig("cocina");
    expect(cocina.loadStations.map((s) => s.id)).toEqual(
      KITCHEN_LOAD_STATIONS.map((s) => s.id),
    );
    expect(cocina.tareaTemplates.map((t) => t.id)).toEqual(
      KITCHEN_TAREA_TEMPLATES.map((t) => t.id),
    );
    expect(cocina.rules.noDoubles).toBe(true);
  });
});
