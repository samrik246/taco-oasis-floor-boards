import { describe, expect, it } from "vitest";
import { stationSolidClass } from "./station-codes";

describe("stationSolidClass", () => {
  it("paints the maroon badge #8c1a11 with white text", () => {
    expect(stationSolidClass("maroon")).toBe("bg-[#8c1a11] text-white");
  });

  it("leaves red unchanged", () => {
    expect(stationSolidClass("red")).toBe("bg-red-500 text-white");
  });
});
