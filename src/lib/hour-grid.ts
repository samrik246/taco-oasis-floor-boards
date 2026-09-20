import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { TIMEZONE, HOUR_GRID_START, HOUR_GRID_END } from "./constants";

/** Chicago wall-clock hour (0–23) for a UTC instant. */
export function chicagoHourOf(date: Date): number {
  return toZonedTime(date, TIMEZONE).getHours();
}

/** Hour start Date (UTC instant) for YYYY-MM-DD + hour in America/Chicago. */
export function chicagoHourStart(dateYmd: string, hour: number): Date {
  const hh = String(hour).padStart(2, "0");
  return fromZonedTime(`${dateYmd}T${hh}:00:00`, TIMEZONE);
}

/** Hour end = start of next hour. */
export function chicagoHourEnd(dateYmd: string, hour: number): Date {
  return chicagoHourStart(dateYmd, hour + 1);
}

/** Hour buckets available on the board grid: [7, 8, ..., 21]. */
export function hourGridHours(): number[] {
  const hours: number[] = [];
  for (let h = HOUR_GRID_START; h < HOUR_GRID_END; h++) {
    hours.push(h);
  }
  return hours;
}

export function formatHourLabel(hour: number): string {
  const suffix = hour >= 12 ? "pm" : "am";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${suffix}`;
}
