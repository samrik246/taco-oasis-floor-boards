import { describe, expect, it } from "vitest";
import { historicalSaleRows } from "./historical-sales";
import {
  buildRushForecast,
  earlierRushText,
  median,
  percentile,
  RUSH_MEDIAN_RATIO,
  rushSummaryText,
} from "./forecast";

describe("historical sales fixture", () => {
  it("seeds four weeks for both boards, every weekday, hours 7–21", () => {
    const rows = historicalSaleRows();
    expect(rows.length).toBe(2 * 7 * 15 * 4);
    const cajaMondayNoon = rows.filter(
      (r) => r.board === "caja" && r.dow === 1 && r.hour === 12,
    );
    expect(cajaMondayNoon.map((r) => r.orders).sort((a, b) => a - b)).toEqual([
      69, 70, 70, 71,
    ]);
  });
});

describe("rush forecast", () => {
  it("marks lunch and dinner above 1.35× the day’s median", () => {
    for (const board of ["caja", "cocina"] as const) {
      for (const date of ["2026-09-20", "2026-09-21", "2026-09-26"]) {
        const forecast = buildRushForecast({ board, dateYmd: date });
        expect(forecast.thresholdRatio).toBe(RUSH_MEDIAN_RATIO);
        expect(forecast.rushHours).toEqual([12, 13, 18, 19]);
        expect(forecast.hours.find((h) => h.hour === 10)?.rush).toBe(false);
        expect(forecast.hours.find((h) => h.hour === 12)?.rush).toBe(true);
        expect(forecast.hours.every((h) => h.sampleCount === 4)).toBe(true);
        const noon = forecast.hours.find((h) => h.hour === 12)!;
        expect(noon.p75).toBeGreaterThan(noon.mean - 1);
      }
    }
  });

  it("does not flag a flat day", () => {
    const history = [7, 12, 18].flatMap((hour) =>
      [1, 2, 3, 4].map((week) => ({
        board: "caja" as const,
        dow: 1,
        hour,
        week,
        orders: 20,
      })),
    );
    const forecast = buildRushForecast({
      board: "caja",
      dateYmd: "2026-09-21",
      history,
    });
    expect(forecast.rushHours).toEqual([]);
    expect(rushSummaryText(forecast, "en")).toMatch(/no hour stands out/i);
  });

  it("writes prep-oriented copy in both board languages", () => {
    const caja = buildRushForecast({
      board: "caja",
      dateYmd: "2026-09-21",
    });
    expect(rushSummaryText(caja, "en")).toBe(
      "Gets busier around 12p–2p and 6p–8p.",
    );
    const cocina = buildRushForecast({
      board: "cocina",
      dateYmd: "2026-09-20",
    });
    expect(rushSummaryText(cocina, "es")).toBe(
      "Se pone más ocupado alrededor de 12p–2p y 6p–8p.",
    );
  });

  it("notes rush hours that sit before a rest-of-day window", () => {
    const forecast = buildRushForecast({
      board: "caja",
      dateYmd: "2026-09-21",
    });
    expect(earlierRushText(forecast, 14, "en")).toBe(
      "Before this window: 12p–2p.",
    );
    expect(earlierRushText(forecast, 7, "es")).toBeNull();
  });
});

describe("percentile and median", () => {
  it("interpolates the 75th percentile", () => {
    expect(percentile([1, 2, 3, 4], 75)).toBeCloseTo(3.25);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(median([10, 30])).toBe(20);
  });
});
