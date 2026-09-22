import { describe, expect, it } from "vitest";
import { preferredBoardDate, preferredBoardHour } from "./startup";

describe("board startup defaults", () => {
  it("selects the current Chicago date instead of a demo or oldest import", () => {
    const now = new Date("2026-09-22T17:00:00.000Z"); // noon Chicago
    expect(preferredBoardDate(["2026-09-20", "2026-09-22"], now)).toBe("2026-09-22");
  });

  it("uses the newest imported date when today is unavailable", () => {
    const now = new Date("2026-09-22T17:00:00.000Z");
    expect(preferredBoardDate(["2026-09-19", "2026-09-20"], now)).toBe("2026-09-20");
  });

  it("keeps startup hour on the usable board grid", () => {
    expect(preferredBoardHour(new Date("2026-09-22T10:00:00.000Z"))).toBe(7);
    expect(preferredBoardHour(new Date("2026-09-23T04:00:00.000Z"))).toBe(21);
  });
});
