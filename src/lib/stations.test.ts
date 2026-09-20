import { describe, expect, it } from "vitest";
import { CAJA_STATIONS, COCINA_STATIONS, ALL_STATIONS } from "@/lib/stations";

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
    expect(nieves?.maxConcurrent).toBe(-1);
  });

  it("seeds cocina stations from SPEC §4.5", () => {
    expect(COCINA_STATIONS.map((s) => s.id)).toEqual([
      "guia_abrir",
      "linea",
      "expo",
      "prep",
      "cerrar",
      "produccion",
      "picar",
      "dish",
    ]);
    const linea = COCINA_STATIONS.find((s) => s.id === "linea");
    expect(linea?.maxConcurrent).toBe(2);
  });

  it("has unique station ids across boards", () => {
    const ids = ALL_STATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
