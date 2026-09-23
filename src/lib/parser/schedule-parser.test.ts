import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { positionStationHint } from "@/lib/board-routing";
import { syntheticCsv, syntheticXlsx } from "../../../tests/helpers/synthetic-schedule";

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

describe("Employee ID is read as displayed text (C1 step 1)", () => {
  const rows = (ids: string[]) =>
    ids.map((employeeId, i) => ({
      position: "Caja - Regular",
      firstName: `Test${i}`,
      lastName: "Person",
      employeeId,
      date: "2030-01-07",
      start: "9:00 am",
      end: "1:00 pm",
    }));

  it("keeps 0042 and 42 as two IDs from CSV", async () => {
    const result = await parseScheduleWorkbook(syntheticCsv(rows(["0042", "42", "007"])), {
      filename: "afternoon.csv",
    });
    expect(result.shifts.map((s) => s.externalId)).toEqual(["0042", "42", "007"]);
  });

  it("keeps 0042 and 42 as two IDs from an xlsx text cell", async () => {
    const buf = await syntheticXlsx(rows(["0042", "42"]));
    const result = await parseScheduleWorkbook(buf, { filename: "morning.xlsx" });
    expect(result.shifts.map((s) => s.externalId)).toEqual(["0042", "42"]);
  });

  it("reads a numeric xlsx ID with its zero-pad format as displayed, and never pads without one", async () => {
    const buf = await syntheticXlsx(rows(["0042", "42"]), {
      numericIds: [{ id: "0042", numFmt: "0000" }, { id: "42" }],
    });
    const result = await parseScheduleWorkbook(buf, { filename: "morning.xlsx" });
    expect(result.shifts.map((s) => s.externalId)).toEqual(["0042", "42"]);
  });

  it("CSV keeps every other column's reading (dates, times)", async () => {
    const result = await parseScheduleWorkbook(syntheticCsv(rows(["0042"])), {
      filename: "afternoon.csv",
    });
    expect(result.dates).toEqual(["2030-01-07"]);
    expect(result.shifts[0]!.startAt.toISOString()).toBe("2030-01-07T15:00:00.000Z");
  });
});
