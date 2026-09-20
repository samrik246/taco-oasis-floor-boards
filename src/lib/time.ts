import { fromZonedTime } from "date-fns-tz";
import { TIMEZONE } from "./constants";

/**
 * Parse When I Work style times like "8:00 am", "3:00 pm", "12:00 pm".
 * Returns { hours, minutes } in 24h clock.
 */
export function parseShiftClockTime(raw: string): { hours: number; minutes: number } {
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) {
    throw new Error(`Unrecognized shift time: ${raw}`);
  }
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const meridiem = m[3].toLowerCase();
  if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid clock time: ${raw}`);
  }
  if (meridiem === "am") {
    if (hours === 12) hours = 0;
  } else {
    if (hours !== 12) hours += 12;
  }
  return { hours, minutes };
}

/** Combine YYYY-MM-DD + clock time into a UTC Date representing that instant in America/Chicago. */
export function chicagoDateTime(dateYmd: string, clock: string): Date {
  const { hours, minutes } = parseShiftClockTime(clock);
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  // fromZonedTime treats the wall-clock string as local in the given tz
  return fromZonedTime(`${dateYmd}T${hh}:${mm}:00`, TIMEZONE);
}

export function isValidYmd(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}
