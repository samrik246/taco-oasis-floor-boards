import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/constants";

/** HH:MM on the restaurant's clock (America/Chicago), whatever the tablet's zone. */
export function chicagoClock(iso: string): string {
  return formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");
}
