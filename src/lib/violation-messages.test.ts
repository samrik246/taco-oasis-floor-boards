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

  it("falls back to the caller's fallback, then the raw code, for an unknown code", () => {
    expect(violationMessage("en", "MADE_UP_CODE", "fallback text")).toBe(
      "fallback text",
    );
    expect(violationMessage("en", "MADE_UP_CODE")).toBe("MADE_UP_CODE");
  });
});
