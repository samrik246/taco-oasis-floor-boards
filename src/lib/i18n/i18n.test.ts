import { describe, expect, it } from "vitest";
import {
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
  });

  it("keeps caja UI English", () => {
    expect(stationLabel("en", "green1")).toBe("Green 1");
    expect(messagesFor("en").cashiers).toBe("Cashiers");
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
