import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { parseScheduleWorkbook, readCsvWorksheet } from "@/lib/parser/schedule-parser";
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

  it("imports employee 0042 as multiple position rows (Regular + Nieves)", async () => {
    const buf = fs.readFileSync(FIXTURE_XLSX);
    const result = await parseScheduleWorkbook(buf, {
      filename: "wheniwork-restaurant-export-sample.xlsx",
    });
    const rows = result.shifts.filter((s) => s.externalId === "0042");
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

describe("A13c: synthetic fixtures", () => {
  const root = process.cwd();
  const csvPaths = {
    "Schedules - Restaurant": path.join(root, "fixtures/schedules-restaurant.csv"),
    "Hourly - Restaurant": path.join(root, "fixtures/hourly-restaurant.csv"),
  } as const;

  it("both CSVs carry empty email cells and the leading-zero pair 0042 / 42", async () => {
    for (const p of Object.values(csvPaths)) {
      const ws = await readCsvWorksheet(fs.readFileSync(p, "utf8"));
      const header = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
      const emailCol = header.indexOf("Email");
      expect(emailCol).toBeGreaterThan(0);
      for (let r = 2; r <= ws.rowCount; r++) {
        expect(ws.getRow(r).getCell(emailCol).value ?? "").toBe("");
      }
    }
    const parsed = await parseScheduleWorkbook(fs.readFileSync(csvPaths["Schedules - Restaurant"]), {
      filename: "schedules-restaurant.csv",
    });
    const ids = new Set(parsed.shifts.map((s) => s.externalId));
    expect(ids.has("0042")).toBe(true);
    expect(ids.has("42")).toBe(true);
  });

  it("the committed xlsx holds the same cell values `pnpm fixture:xlsx` builds from the CSVs", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fs.readFileSync(FIXTURE_XLSX) as unknown as ExcelJS.Buffer);
    for (const [sheet, p] of Object.entries(csvPaths)) {
      const expected = await readCsvWorksheet(fs.readFileSync(p, "utf8"));
      const actual = wb.getWorksheet(sheet);
      expect(actual, sheet).toBeTruthy();
      // An all-empty CSV line has no cells to write, so xlsx drops it at the end.
      const cells = (ws: ExcelJS.Worksheet, r: number) => {
        const out = [...(ws.getRow(r).values as unknown[])].map((v) =>
          v instanceof Date ? v.toISOString() : v == null || v === "" ? null : v,
        );
        while (out.length && out[out.length - 1] === null) out.pop();
        return out;
      };
      const rows = Math.max(expected.rowCount, actual!.rowCount);
      let compared = 0;
      for (let r = 1; r <= rows; r++) {
        expect(cells(actual!, r), `${sheet} row ${r}`).toEqual(cells(expected, r));
        if (cells(expected, r).length) compared += 1;
      }
      expect(compared).toBeGreaterThan(90);
    }
  });

  it("the xlsx and the CSV parse to the same shifts", async () => {
    const fromXlsx = await parseScheduleWorkbook(fs.readFileSync(FIXTURE_XLSX), {
      filename: "wheniwork-restaurant-export-sample.xlsx",
    });
    const fromCsv = await parseScheduleWorkbook(fs.readFileSync(csvPaths["Schedules - Restaurant"]), {
      filename: "schedules-restaurant.csv",
    });
    expect(fromXlsx.shifts).toEqual(fromCsv.shifts);
  });
});

describe("open shifts (C1 step 6)", () => {
  it("skips rows with no Employee ID and counts them per date; incomplete staff rows still fail", async () => {
    const base = {
      position: "Caja - Regular",
      firstName: "",
      lastName: "",
      date: "2030-08-05",
      start: "9:00 am",
      end: "1:00 pm",
    };
    const csv = syntheticCsv([
      { ...base, employeeId: "" },
      { ...base, employeeId: "", date: "2030-08-06" },
      { ...base, employeeId: "" },
      { ...base, employeeId: "5401", firstName: "Jaime", lastName: "Demo" },
    ]);
    const result = await parseScheduleWorkbook(csv, { filename: "open.csv" });
    expect(result.shifts.map((s) => s.externalId)).toEqual(["5401"]);
    expect(result.skippedOpenShifts).toEqual({ "2030-08-05": 2, "2030-08-06": 1 });

    const broken = syntheticCsv([{ ...base, employeeId: "5402", start: "" }]);
    await expect(parseScheduleWorkbook(broken, { filename: "broken.csv" })).rejects.toThrow(
      /Incomplete schedule row/,
    );
  });
});
