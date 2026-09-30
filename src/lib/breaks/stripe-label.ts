import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/constants";

export type BreakStripe = {
  employeeId: string;
  shiftId: string;
  startAt: string;
  endAt: string;
  coverEmployeeId?: string | null;
  auto?: boolean;
};

function overlaps(start: Date, end: Date, otherStart: Date, otherEnd: Date): boolean {
  return start.getTime() < otherEnd.getTime() && otherStart.getTime() < end.getTime();
}

/** Chicago HH:mm-HH:mm when this hour overlaps that person's break on this shift. */
export function breakStripeLabel(
  breaks: readonly BreakStripe[] | undefined,
  employeeId: string,
  shiftId: string,
  hourStart: Date,
  hourEnd: Date,
): string | null {
  const hit = (breaks ?? []).find((row) => {
    return row.employeeId === employeeId
      && row.shiftId === shiftId
      && overlaps(new Date(row.startAt), new Date(row.endAt), hourStart, hourEnd);
  });
  if (!hit) return null;
  const start = formatInTimeZone(new Date(hit.startAt), TIMEZONE, "HH:mm");
  const end = formatInTimeZone(new Date(hit.endAt), TIMEZONE, "HH:mm");
  return `${start}-${end}`;
}
