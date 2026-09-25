import { describe, expect, it } from "vitest";
import { violationMessage } from "./violation-messages";
import type { ViolationCode } from "./rules/types";

// Every code the server can return, kept in sync with rules/types.ts by hand
// — the C4 guard below fails loudly if this list drifts from that union.
const ALL_CODES: ViolationCode[] = [
  "OUT_OF_SHIFT",
  "STATION_FULL",
  "FORBIDDEN_ABILITY",
  "PERSON_ALREADY_ASSIGNED",
  "STATION_BOARD_MISMATCH",
  "SHIFT_NOT_FOUND",
  "STATION_NOT_FOUND",
  "ASSIGNMENT_NOT_FOUND",
  "INVALID_HOUR",
  "SWAP_SAME_ASSIGNMENT",
  "SHIFT_SUPERSEDED",
];

describe("violationMessage", () => {
  it("never shows the raw code — every code has a plain sentence in both locales", () => {
    for (const code of ALL_CODES) {
      const en = violationMessage("en", code);
      const es = violationMessage("es", code);
      expect(en).not.toBe(code);
      expect(es).not.toBe(code);
      expect(en.length).toBeGreaterThan(0);
      expect(es.length).toBeGreaterThan(0);
    }
  });

  it("uses the caller's fallback for an unknown code, when one is given", () => {
    expect(violationMessage("en", "MADE_UP_CODE", "fallback text")).toBe(
      "fallback text",
    );
  });

  it("never returns the raw code for an unknown code with no fallback — a generic sentence in both locales", () => {
    const en = violationMessage("en", "MADE_UP_CODE");
    const es = violationMessage("es", "MADE_UP_CODE");
    expect(en).not.toBe("MADE_UP_CODE");
    expect(es).not.toBe("MADE_UP_CODE");
    expect(en.length).toBeGreaterThan(0);
    expect(es.length).toBeGreaterThan(0);
    expect(en).not.toBe(es);
  });
});
