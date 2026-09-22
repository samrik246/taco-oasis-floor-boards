import { describe, expect, it } from "vitest";
import { isCurrentBoardRequest, liveRefreshState, offlineRefreshState } from "./refresh-state";

const cajaCache = {
  version: 1 as const,
  board: "caja" as const,
  date: "2026-09-22",
  day: { stations: ["caja"] },
  savedAt: "2026-09-22T12:00:00.000Z",
};

describe("board refresh state", () => {
  it("locks editing when a failed fetch has no cache", () => {
    expect(offlineRefreshState("cocina", null)).toEqual({ offline: true, day: null, date: null });
  });

  it("locks editing without showing another board's cache", () => {
    expect(offlineRefreshState("cocina", cajaCache)).toEqual({ offline: true, day: null, date: null });
  });

  it("uses a matching cache while offline and unlocks after a successful retry", () => {
    expect(offlineRefreshState("caja", cajaCache)).toEqual({
      offline: true,
      day: cajaCache.day,
      date: cajaCache.date,
    });
    expect(liveRefreshState({ stations: ["live"] })).toEqual({
      offline: false,
      day: { stations: ["live"] },
    });
  });

  it("rejects a delayed response for the previously selected board or date", () => {
    expect(isCurrentBoardRequest(
      { board: "cocina", date: "2026-09-22" },
      { board: "caja", date: "2026-09-22" },
    )).toBe(false);
    expect(isCurrentBoardRequest(
      { board: "cocina", date: "2026-09-23" },
      { board: "cocina", date: "2026-09-22" },
    )).toBe(false);
  });
});
