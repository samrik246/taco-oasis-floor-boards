import { fromZonedTime } from "date-fns-tz";
import { TIMEZONE } from "./constants";
import { chicagoYmd } from "./schedule/build-schedule";

/**
 * dateYmd shifted by `days` calendar days in America/Chicago. Anchors at
 * Chicago noon before adding whole days in UTC millis, so a DST transition
 * inside the window never shifts the resulting calendar date by one.
 */
export function chicagoDateOffset(dateYmd: string, days: number): string {
  const noon = fromZonedTime(`${dateYmd}T12:00:00`, TIMEZONE);
  const shifted = new Date(noon.getTime() + days * 24 * 60 * 60 * 1000);
  return chicagoYmd(shifted);
}
