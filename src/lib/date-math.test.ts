import { describe, expect, it } from "vitest";
import { chicagoDateOffset } from "./date-math";

describe("chicagoDateOffset", () => {
  it("steps a plain day backward and forward", () => {
    expect(chicagoDateOffset("2026-09-25", -1)).toBe("2026-09-24");
    expect(chicagoDateOffset("2026-09-25", -7)).toBe("2026-09-18");
    expect(chicagoDateOffset("2026-09-25", 1)).toBe("2026-09-26");
  });

  it("crosses the fall-back DST boundary (2026-11-01) without an off-by-one", () => {
    expect(chicagoDateOffset("2026-11-02", -1)).toBe("2026-11-01");
    expect(chicagoDateOffset("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("crosses the spring-forward DST boundary (2026-03-08) without an off-by-one", () => {
    expect(chicagoDateOffset("2026-03-09", -1)).toBe("2026-03-08");
    expect(chicagoDateOffset("2026-03-08", -1)).toBe("2026-03-07");
  });

  it("crosses a year boundary", () => {
    expect(chicagoDateOffset("2027-01-01", -1)).toBe("2026-12-31");
  });
});
