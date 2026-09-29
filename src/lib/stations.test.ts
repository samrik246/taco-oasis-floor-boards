import { describe, expect, it } from "vitest";
import { CAJA_STATIONS, COCINA_STATIONS, ALL_STATIONS } from "@/lib/stations";
import { getBoardConfig } from "@/lib/board-config";
import { KITCHEN_LOAD_STATIONS } from "@/lib/load-stations";
import { KITCHEN_TAREA_TEMPLATES } from "@/lib/tareas/catalog";
import { STATION_SHORT_CODES } from "@/lib/schedule/station-codes";
import ownerDecisions from "../../operations/position-names-2026-09-26.json";

describe("station seed dictionaries", () => {
  it("seeds all caja stations from SPEC §4.4", () => {
    expect(CAJA_STATIONS.map((s) => s.id)).toEqual([
      "mana",
      "green1",
      "yellow",
      "yellow2",
      "purple1",
      "green2",
      "blue",
      "purple2",
      "multi",
      "nieves",
      "nieves2",
      "mesero",
      "clean",
    ]);
    const nieves = CAJA_STATIONS.find((s) => s.id === "nieves");
    expect(nieves?.maxConcurrent).toBe(1);
  });

  it("seeds the 20 Cocina seats and omits the six retired seats", () => {
    expect(COCINA_STATIONS.map((s) => s.id)).toEqual([
      "pdf_br2a", "pdf_crne", "pdf_pr3e", "pdf_rlno", "pdf_cyrl", "pdf_rngn",
      "pdf_tf1r", "pdf_tsr2", "pdf_guia", "pdf_pr1e", "pdf_tq1r",
      "pdf_tq2r", "pdf_tq3r", "pdf_pr2e", "pdf_tf2r", "pdf_pstl",
      "pdf_br1a", "pdf_tsrea", "pdf_tsr3", "pdf_tsr4",
    ]);
    for (const s of COCINA_STATIONS) {
      expect(s.maxConcurrent).toBe(1);
    }
  });

  it("has unique station ids across boards", () => {
    const ids = ALL_STATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the 32 retained owner names and adds Carne y Relleno", () => {
    const retained = ownerDecisions.decisions.filter((d) => d.action !== "remove_if_unreferenced");
    expect(ALL_STATIONS).toHaveLength(33);
    const carne = ALL_STATIONS.find((s) => s.id === "pdf_cyrl");
    expect(carne).toMatchObject({
      board: "cocina",
      label: "Carne y Relleno",
      color: "dark-orange",
      maxConcurrent: 1,
      sortOrder: 0,
      priority: null,
    });
    expect(STATION_SHORT_CODES.pdf_cyrl).toBe("CYRL");
    for (const decision of retained) {
      const station = ALL_STATIONS.find((s) => s.id === decision.station_id);
      expect(station?.board).toBe(decision.board);
      expect(station?.label).toBe(decision.final_label);
      expect(STATION_SHORT_CODES[decision.station_id]).toBe(decision.code_at_memo);
    }
    for (const decision of ownerDecisions.decisions.filter((d) => d.action === "remove_if_unreferenced")) {
      expect(ALL_STATIONS.some((s) => s.id === decision.station_id)).toBe(false);
    }
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
