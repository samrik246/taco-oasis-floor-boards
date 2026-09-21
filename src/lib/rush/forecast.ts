import { toZonedTime } from "date-fns-tz";
import { TIMEZONE } from "@/lib/constants";
import {
  chicagoHourOf,
  formatCompactHour,
  hourGridHours,
} from "@/lib/hour-grid";
import {
  historicalSaleRows,
  type HistoricalHourlySale,
  type RushBoard,
} from "./historical-sales";

/**
 * An hour is a rush when its mean share of that day’s sales is strictly
 * above this multiple of the weekday’s median hourly share. 1.35 keeps
 * ordinary bumps from lighting up, and marks the lunch and dinner peaks
 * in the sample history. The input is percent-of-day, not order counts.
 */
export const RUSH_MEDIAN_RATIO = 1.35;

/** One banner this many minutes before a historical rush window starts. */
export const RUSH_LEAD_MINUTES = 20;

export type RushHourStat = {
  hour: number;
  /** Mean percent of that day’s sales (0–100), not orders or raw dollars. */
  mean: number;
  /** 75th percentile of the percent-of-day samples. */
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
  /** Median of the hourly mean percents (percent of day, not orders). */
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
 * For each sample week, convert hour sales into a percent of that day’s
 * sales, then collect those percents per hour.
 */
export function sharesByHour(
  history: HistoricalHourlySale[],
  board: RushBoard,
  dow: number,
): Map<number, number[]> {
  const byWeek = new Map<number, Map<number, number>>();
  for (const row of history) {
    if (row.board !== board || row.dow !== dow) continue;
    const hours = byWeek.get(row.week) ?? new Map<number, number>();
    hours.set(row.hour, (hours.get(row.hour) ?? 0) + row.salesCents);
    byWeek.set(row.week, hours);
  }

  const byHour = new Map<number, number[]>();
  for (const hours of byWeek.values()) {
    let total = 0;
    for (const cents of hours.values()) total += cents;
    if (total <= 0) continue;
    for (const [hour, cents] of hours) {
      const list = byHour.get(hour) ?? [];
      list.push((cents / total) * 100);
      byHour.set(hour, list);
    }
  }
  return byHour;
}

/**
 * Hourly mean and 75th percentile of percent-of-day sales for one board
 * and weekday, then flag rush hours against that day’s median hourly share.
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
  const byHour = sharesByHour(history, opts.board, dow);

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

export type RushLeadNotice = {
  minutesUntil: number;
  startHour: number;
  rangeLabel: string;
  text: string;
};

/**
 * One notice when the clock is inside the lead window before the next
 * historical rush on this calendar date. No second forecast, no chime.
 * Returns null once the window has started, or when it is more than
 * RUSH_LEAD_MINUTES away.
 */
export function rushLeadNotice(opts: {
  forecast: RushForecast;
  now: Date;
  dateYmd: string;
  locale: "en" | "es";
  leadMinutes?: number;
}): RushLeadNotice | null {
  const lead = opts.leadMinutes ?? RUSH_LEAD_MINUTES;
  const today = chicagoYmdFrom(opts.now);
  if (today !== opts.dateYmd) return null;
  if (opts.forecast.ranges.length === 0) return null;

  const hour = chicagoHourOf(opts.now);
  const minute = chicagoMinuteOf(opts.now);
  const nowMinutes = hour * 60 + minute;

  let best: { minutesUntil: number; range: RushRange } | null = null;
  for (const range of opts.forecast.ranges) {
    const startMinutes = range.startHour * 60;
    const minutesUntil = startMinutes - nowMinutes;
    if (minutesUntil <= 0 || minutesUntil > lead) continue;
    if (!best || minutesUntil < best.minutesUntil) {
      best = { minutesUntil, range };
    }
  }
  if (!best) return null;

  const rangeLabel = formatRushRange(best.range);
  const text =
    opts.locale === "es"
      ? `El pico empieza en ${best.minutesUntil} min (${rangeLabel}).`
      : `Rush starts in ${best.minutesUntil} min (${rangeLabel}).`;
  return {
    minutesUntil: best.minutesUntil,
    startHour: best.range.startHour,
    rangeLabel,
    text,
  };
}

function chicagoYmdFrom(date: Date): string {
  const local = toZonedTime(date, TIMEZONE);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const d = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function chicagoMinuteOf(date: Date): number {
  return toZonedTime(date, TIMEZONE).getMinutes();
}
