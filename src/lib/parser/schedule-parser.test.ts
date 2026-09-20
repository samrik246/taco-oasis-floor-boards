import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { positionStationHint } from "@/lib/board-routing";

const FIXTURE_XLSX = path.resolve(
  process.cwd(),
  "fixtures/wheniwork-restaurant-export-sample.xlsx",
);

describe("schedule xlsx parser (sample fixture)", () => {
  it("parses Schedules - Restaurant with expected bucket counts and date span", async () => {
    expect(fs.existsSync(FIXTURE_XLSX)).toBe(true);
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const result = await parseScheduleWorkbook(buf, {
      filename: "wheniwork-restaurant-export-sample.xlsx",
    });

    // SPEC §10: caja ~109, cocina ~105, other ~19 (±5)
    expect(result.bucketCounts.caja).toBeGreaterThanOrEqual(109 - 5);
    expect(result.bucketCounts.caja).toBeLessThanOrEqual(109 + 5);
    expect(result.bucketCounts.cocina).toBeGreaterThanOrEqual(105 - 5);
    expect(result.bucketCounts.cocina).toBeLessThanOrEqual(105 + 5);
    expect(result.bucketCounts.other).toBeGreaterThanOrEqual(19 - 5);
    expect(result.bucketCounts.other).toBeLessThanOrEqual(19 + 5);

    expect(result.dates[0]).toBe("2026-09-18");
    expect(result.dates[result.dates.length - 1]).toBe("2026-09-24");
    expect(result.dates).toEqual([
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
    ]);

    // Pay columns present in export headers but never on DTOs
    expect(result.strippedPayColumns).toEqual(
      expect.arrayContaining(["Hourly Rate", "Labor Cost"]),
    );
    for (const s of result.shifts) {
      expect(s).not.toHaveProperty("hourlyRate");
      expect(s).not.toHaveProperty("laborCost");
      expect(Object.keys(s)).not.toContain("Hourly Rate");
      expect(Object.keys(s)).not.toContain("Labor Cost");
      expect(Object.keys(s)).not.toContain("Total");
    }
  });

  it("imports employee 8304 as multiple position rows (Regular + Nieves)", async () => {
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const result = await parseScheduleWorkbook(buf, {
      filename: "wheniwork-restaurant-export-sample.xlsx",
    });
    const rows = result.shifts.filter((s) => s.externalId === "8304");
    expect(rows.length).toBeGreaterThan(1);
    const positions = new Set(rows.map((r) => r.sourcePosition));
    expect(positions.has("Caja - Regular")).toBe(true);
    expect(positions.has("Caja - Nieves")).toBe(true);
  });

  it("normalizes Caja - Meser@ station hint to mesero", () => {
    expect(positionStationHint("Caja - Meser@")).toBe("mesero");
  });
});
