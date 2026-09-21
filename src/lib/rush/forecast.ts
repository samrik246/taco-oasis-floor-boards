import { formatCompactHour, hourGridHours } from "@/lib/hour-grid";
import {
  historicalSaleRows,
  type HistoricalHourlySale,
  type RushBoard,
} from "./historical-sales";

/**
 * An hour is a rush when its mean orders are strictly above this multiple
 * of the weekday’s median hourly mean. 1.35 keeps ordinary bumps (a few
 * orders over the middle of the day) from lighting up, and marks the
 * lunch and dinner peaks in the sample history.
 */
export const RUSH_MEDIAN_RATIO = 1.35;

export type RushHourStat = {
  hour: number;
  mean: number;
  p75: number;
  sampleCount: number;
  rush: boolean;
};

export type RushRange = {
  startHour: number;
  /** Exclusive end, so 12→14 reads as 12p–2p. */
  endHourExclusive: number;
};

export type RushForecast = {
  board: RushBoard;
  /** 0 = Sunday … 6 = Saturday, from the calendar date (not the clock zone). */
  dow: number;
  dayMedian: number;
  thresholdRatio: number;
  /** dayMedian * thresholdRatio. Rush hours are strictly above this. */
  threshold: number;
  hours: RushHourStat[];
  rushHours: number[];
  ranges: RushRange[];
};

export function dowFromYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map((part) => Number(part));
  if (!y || !m || !d) return 0;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Linear percentile on a copy of the values. p is 0–100. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const weight = idx - lo;
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight;
}

/** Median of a list. Even length uses the average of the two middle values. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mergeRushRanges(rushHours: number[]): RushRange[] {
  const sorted = [...rushHours].sort((a, b) => a - b);
  const ranges: RushRange[] = [];
  for (const hour of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.endHourExclusive === hour) {
      last.endHourExclusive = hour + 1;
    } else {
      ranges.push({ startHour: hour, endHourExclusive: hour + 1 });
    }
  }
  return ranges;
}

export function formatRushRange(range: RushRange): string {
  return `${formatCompactHour(range.startHour)}–${formatCompactHour(range.endHourExclusive)}`;
}

function joinList(parts: string[], locale: "en" | "es"): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) {
    return locale === "es"
      ? `${parts[0]} y ${parts[1]}`
      : `${parts[0]} and ${parts[1]}`;
  }
  const head = parts.slice(0, -1).join(", ");
  const tail = parts[parts.length - 1];
  return locale === "es" ? `${head} y ${tail}` : `${head}, and ${tail}`;
}

/**
 * Hourly mean and 75th percentile for one board and weekday, then flag
 * rush hours against that day’s median hourly mean.
 */
export function buildRushForecast(opts: {
  board: RushBoard;
  dateYmd: string;
  history?: HistoricalHourlySale[];
  thresholdRatio?: number;
}): RushForecast {
  const history = opts.history ?? historicalSaleRows();
  const dow = dowFromYmd(opts.dateYmd);
  const ratio = opts.thresholdRatio ?? RUSH_MEDIAN_RATIO;
  const grid = hourGridHours();

  const byHour = new Map<number, number[]>();
  for (const row of history) {
    if (row.board !== opts.board || row.dow !== dow) continue;
    const list = byHour.get(row.hour) ?? [];
    list.push(row.orders);
    byHour.set(row.hour, list);
  }

  const preliminary = grid.map((hour) => {
    const samples = byHour.get(hour) ?? [];
    return {
      hour,
      mean: mean(samples),
      p75: percentile(samples, 75),
      sampleCount: samples.length,
    };
  });

  const dayMedian = median(
    preliminary.filter((h) => h.sampleCount > 0).map((h) => h.mean),
  );
  const threshold = dayMedian * ratio;
  const hours: RushHourStat[] = preliminary.map((h) => ({
    ...h,
    rush: h.sampleCount > 0 && h.mean > threshold,
  }));
  const rushHours = hours.filter((h) => h.rush).map((h) => h.hour);

  return {
    board: opts.board,
    dow,
    dayMedian,
    thresholdRatio: ratio,
    threshold,
    hours,
    rushHours,
    ranges: mergeRushRanges(rushHours),
  };
}

/** Plain-language rush windows for the board locale. */
export function rushSummaryText(
  forecast: RushForecast,
  locale: "en" | "es",
): string {
  if (forecast.ranges.length === 0) {
    return locale === "es"
      ? "Ninguna hora destaca como pico frente a la mediana de este día."
      : "No hour stands out above this day's median.";
  }
  const list = joinList(forecast.ranges.map(formatRushRange), locale);
  return locale === "es"
    ? `Se pone más ocupado alrededor de ${list}.`
    : `Gets busier around ${list}.`;
}

/** Rush hours that fall before a rest-of-day window, if any. */
export function earlierRushText(
  forecast: RushForecast,
  startHour: number,
  locale: "en" | "es",
): string | null {
  const earlier = forecast.rushHours.filter((h) => h < startHour);
  if (earlier.length === 0) return null;
  const list = joinList(
    mergeRushRanges(earlier).map(formatRushRange),
    locale,
  );
  return locale === "es"
    ? `Antes de esta ventana: ${list}.`
    : `Before this window: ${list}.`;
}
