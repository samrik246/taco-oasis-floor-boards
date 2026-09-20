import { describe, expect, it } from "vitest";
import {
  busynessFromOrderCount,
  CASHIER_LOAD_STATIONS,
  loadStationForSeat,
} from "@/lib/load-stations";
import { draftReturnPrompts } from "@/lib/return-to-station";
import { suggestAssignees } from "@/lib/suggestions";
import {
  CASHIER_TAREA_TEMPLATES,
  isBacklogWhenSlow,
  isLemonWarnTemplate,
} from "@/lib/tareas/catalog";
import { metersFromCounts, simulateTick } from "@/lib/traffic/simulator";
import { isValidMoveReason, MOVE_REASONS } from "@/lib/position-moves";
import { CAJA_STATIONS } from "@/lib/stations";

describe("Phase 1: Nieves one-per-station", () => {
  it("nieves maxConcurrent is 1", () => {
    expect(CAJA_STATIONS.find((s) => s.id === "nieves")?.maxConcurrent).toBe(1);
  });
});

describe("Phase 1: load-station map", () => {
  it("maps cliente to both greens, carro to yellow+blue, expo to purples", () => {
    expect(loadStationForSeat("green1")?.id).toBe("cliente");
    expect(loadStationForSeat("green2")?.id).toBe("cliente");
    expect(loadStationForSeat("yellow")?.id).toBe("carro");
    expect(loadStationForSeat("blue")?.id).toBe("carro");
    expect(loadStationForSeat("purple1")?.id).toBe("expo");
    expect(loadStationForSeat("purple2")?.id).toBe("expo");
    expect(loadStationForSeat("nieves")?.id).toBe("nieves");
    expect(CASHIER_LOAD_STATIONS).toHaveLength(4);
  });

  it("derives Quiet/Busy/Slammed from order counts", () => {
    expect(busynessFromOrderCount(0)).toBe("quiet");
    expect(busynessFromOrderCount(3)).toBe("quiet");
    expect(busynessFromOrderCount(4)).toBe("busy");
    expect(busynessFromOrderCount(8)).toBe("slammed");
  });
});

describe("Phase 1: traffic simulator", () => {
  it("produces meters for all load stations", () => {
    const counts = simulateTick({ now: new Date("2026-09-20T16:00:00Z") });
    const meters = metersFromCounts(counts);
    expect(meters.map((m) => m.loadStationId).sort()).toEqual([
      "carro",
      "cliente",
      "expo",
      "nieves",
    ]);
    for (const m of meters) {
      expect(["quiet", "busy", "slammed"]).toContain(m.level);
    }
  });
});

describe("Phase 1: return-to-station drafts", () => {
  it("prompts seat assignee and MULTI when slammed with working tareas", () => {
    const drafts = draftReturnPrompts({
      meters: [
        { loadStationId: "cliente", level: "slammed" },
        { loadStationId: "nieves", level: "quiet" },
        { loadStationId: "carro", level: "quiet" },
        { loadStationId: "expo", level: "quiet" },
      ],
      seatAssignees: [
        { employeeId: "e1", seatId: "green1", displayName: "Ana" },
        { employeeId: "e2", seatId: "multi", displayName: "Bob" },
        { employeeId: "e3", seatId: "yellow", displayName: "Cara" },
      ],
      workingTareas: [
        { id: "t1", employeeId: "e1", templateLabel: "SALSA" },
        { id: "t2", employeeId: "e2", templateLabel: "CHILES" },
        { id: "t3", employeeId: "e3", templateLabel: "RANCH" },
      ],
    });
    const ids = drafts.map((d) => d.employeeId).sort();
    expect(ids).toContain("e1");
    expect(ids).toContain("e2");
    expect(ids).not.toContain("e3"); // carro not slammed
  });
});

describe("Phase 1: tareas catalog", () => {
  it("has one simplified daily list including chiles backlog and lemon warn", () => {
    expect(CASHIER_TAREA_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    expect(isBacklogWhenSlow("desvenar_chiles")).toBe(true);
    expect(isLemonWarnTemplate("lemon")).toBe(true);
  });
});

describe("Phase 1: suggestion engine (opaque labels)", () => {
  it("returns top/next labels without exposing scores", () => {
    const slots = suggestAssignees({
      templateId: "salsa",
      candidates: [
        {
          employeeId: "a",
          displayName: "Ada",
          seatId: "multi",
          abilityLevel: "preferred",
          positionFit: 10,
          activeTareaCount: 0,
        },
        {
          employeeId: "b",
          displayName: "Ben",
          seatId: "green1",
          abilityLevel: "ok",
          positionFit: 5,
          activeTareaCount: 2,
        },
      ],
    });
    expect(slots[0]?.label).toBe("top");
    expect(slots[1]?.label).toBe("next");
    expect(JSON.stringify(slots)).not.toMatch(/rank/i);
  });
});

describe("Phase 1: move reasons", () => {
  it("accepts the locked dropdown set", () => {
    expect(MOVE_REASONS).toEqual([
      "Break",
      "Cover expo",
      "Training",
      "Help slammed",
      "Other",
    ]);
    expect(isValidMoveReason("Break")).toBe(true);
    expect(isValidMoveReason("Vacation")).toBe(false);
  });
});
