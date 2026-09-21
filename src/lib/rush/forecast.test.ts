import { describe, expect, it } from "vitest";
import { historicalSaleRows } from "./historical-sales";
import {
  buildRushForecast,
  earlierRushText,
  median,
  percentile,
  RUSH_LEAD_MINUTES,
  RUSH_MEDIAN_RATIO,
  rushLeadNotice,
  rushSummaryText,
} from "./forecast";
import { chicagoDateTime } from "@/lib/time";

describe("historical sales fixture", () => {
  it("seeds four weeks for both boards, every weekday, hours 7–21", () => {
    const rows = historicalSaleRows();
    expect(rows.length).toBe(2 * 7 * 15 * 4);
    const cajaMondayNoon = rows.filter(
      (r) => r.board === "caja" && r.dow === 1 && r.hour === 12,
    );
    expect(cajaMondayNoon.map((r) => r.salesCents).sort((a, b) => a - b)).toEqual([
      6900, 7000, 7000, 7100,
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
        salesCents: 2000,
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

  it("uses percent of that day’s sales, not raw order counts", () => {
    const history = [7, 12, 18].flatMap((hour) => [
      {
        board: "caja" as const,
        dow: 1,
        hour,
        week: 1,
        salesCents: hour === 12 ? 8_000 : 1_000,
      },
    ]);
    const forecast = buildRushForecast({
      board: "caja",
      dateYmd: "2026-09-21",
      history,
    });
    const noon = forecast.hours.find((h) => h.hour === 12)!;
    expect(noon.mean).toBeCloseTo(80, 5);
    expect(noon.mean).toBeLessThan(100);
    expect(forecast.rushHours).toEqual([12]);
  });

  it("shows one lead notice about 20 minutes before a rush, and not during it", () => {
    const forecast = buildRushForecast({
      board: "caja",
      dateYmd: "2026-09-21",
    });
    expect(RUSH_LEAD_MINUTES).toBe(20);
    const soon = rushLeadNotice({
      forecast,
      now: chicagoDateTime("2026-09-21", "11:45 am"),
      dateYmd: "2026-09-21",
      locale: "en",
    });
    expect(soon?.text).toBe("Rush starts in 15 min (12p–2p).");
    expect(soon?.minutesUntil).toBe(15);
    expect(
      rushLeadNotice({
        forecast,
        now: chicagoDateTime("2026-09-21", "11:00 am"),
        dateYmd: "2026-09-21",
        locale: "en",
      }),
    ).toBeNull();
    expect(
      rushLeadNotice({
        forecast,
        now: chicagoDateTime("2026-09-21", "12:05 pm"),
        dateYmd: "2026-09-21",
        locale: "es",
      }),
    ).toBeNull();
    const dinner = rushLeadNotice({
      forecast,
      now: chicagoDateTime("2026-09-21", "5:45 pm"),
      dateYmd: "2026-09-21",
      locale: "es",
    });
    expect(dinner?.text).toMatch(/15 min/);
    expect(dinner?.text).toMatch(/6p/);
  });
});

describe("percentile and median", () => {
  it("interpolates the 75th percentile", () => {
    expect(percentile([1, 2, 3, 4], 75)).toBeCloseTo(3.25);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(median([10, 30])).toBe(20);
  });
});
