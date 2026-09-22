import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";
import { chicagoHourOf } from "@/lib/hour-grid";
import { chicagoYmd } from "@/lib/schedule/build-schedule";

/** Choose today when it is imported; otherwise retain the API's newest date. */
export function preferredBoardDate(dates: string[], now: Date): string {
  const today = chicagoYmd(now);
  if (dates.includes(today)) return today;
  return dates.at(-1) ?? "";
}

/** Keep the initial selection on the board's 7am–9pm grid. */
export function preferredBoardHour(now: Date): number {
  const hour = chicagoHourOf(now);
  if (hour < HOUR_GRID_START) return HOUR_GRID_START;
  if (hour >= HOUR_GRID_END) return HOUR_GRID_END - 1;
  return hour;
}
