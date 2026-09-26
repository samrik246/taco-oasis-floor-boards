import { describe, expect, it } from "vitest";
import {
  abilityLevelLabel,
  boardDisplayName,
  localeForBoard,
  messagesFor,
  stationLabel,
  tareaLabel,
} from "@/lib/i18n";
import {
  DEMO_MANAGERS,
  hashManagerCode,
  managerIdleMsFromEnv,
  verifyManagerCodeHash,
} from "@/lib/managers/codes";

describe("i18n board locale", () => {
  it("maps caja→en and cocina→es", () => {
    expect(localeForBoard("caja")).toBe("en");
    expect(localeForBoard("cocina")).toBe("es");
  });

  it("localizes cocina station and tarea labels", () => {
    expect(stationLabel("es", "fryer")).toBe("Freidora");
    expect(tareaLabel("es", "restock_tortillas")).toMatch(/tortillas/i);
    expect(boardDisplayName("es", "cocina")).toBe("Cocina");
    expect(messagesFor("es").orderTraffic).toMatch(/Tráfico/i);
    expect(messagesFor("es").viewSchedule).toBe("Horario");
    expect(messagesFor("es").scheduleAllDay).toBe("Día");
    expect(messagesFor("es").scheduleRestOfDay).toBe("Resto");
  });

  it("keeps caja UI English", () => {
    expect(stationLabel("en", "green1")).toBe("Green 1");
    expect(messagesFor("en").cashiers).toBe("Cashiers");
    expect(messagesFor("en").viewSchedule).toBe("Schedule");
    expect(messagesFor("en").scheduleAllDay).toBe("Day");
  });

  it("translates every ability level, never the raw code, in both locales", () => {
    const levels = ["preferred", "ok", "training", "forbidden"] as const;
    for (const level of levels) {
      expect(abilityLevelLabel("en", level)).not.toBe(level);
      expect(abilityLevelLabel("es", level)).not.toBe(level);
    }
    expect(abilityLevelLabel("es", "forbidden")).toBe("Prohibida");
    expect(abilityLevelLabel("en", "forbidden")).toBe("Forbidden");
  });

  it("joins the whole-shift card parts in order, dropping zero counts", () => {
    const breakdown = {
      placed: 3,
      occupied: 3, // stationOccupied 2 + personBusy 1, never + superseded
      alreadyThere: 2,
      superseded: 1,
    };
    expect(messagesFor("es").assignedPartial(breakdown)).toBe(
      "Asignado 3 h, 3 h ocupadas, 2 h ya asignadas, reemplazados 1",
    );
    expect(messagesFor("en").assignedPartial(breakdown)).toBe(
      "Assigned 3 h, 3 h busy, 2 h already assigned, superseded 1",
    );
    expect(
      messagesFor("es").assignedPartial({
        placed: 0,
        occupied: 0,
        alreadyThere: 5,
        superseded: 0,
      }),
    ).toBe("5 h ya asignadas");
  });
});

describe("manager codes", () => {
  it("hashes and verifies demo codes", () => {
    for (const m of DEMO_MANAGERS) {
      const hash = hashManagerCode(m.code);
      expect(hash).not.toContain(m.code);
      expect(verifyManagerCodeHash(m.code, hash)).toBe(true);
      expect(verifyManagerCodeHash("0000", hash)).toBe(false);
    }
  });

  it("reads MANAGER_IDLE_MS with safe default", () => {
    expect(managerIdleMsFromEnv({})).toBe(15_000);
    expect(managerIdleMsFromEnv({ MANAGER_IDLE_MS: "1500" })).toBe(1500);
    expect(managerIdleMsFromEnv({ MANAGER_IDLE_MS: "nope" })).toBe(15_000);
  });
});
