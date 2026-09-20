import { describe, expect, it } from "vitest";
import { NoOpAutoFill } from "@/lib/auto-fill";

describe("NoOpAutoFill", () => {
  it("returns no suggestions", () => {
    const engine = new NoOpAutoFill();
    expect(engine.suggest({ board: "caja", date: "2026-09-20" })).toEqual([]);
  });
});
