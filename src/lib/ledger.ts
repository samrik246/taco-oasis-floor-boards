import { TIMEZONE } from "@/lib/constants";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import type { EmployeeHoursLedger, LedgerStationRow } from "@/lib/ledger-types";

export type { EmployeeHoursLedger, LedgerStationRow };

/** Format local Chicago calendar components as YYYY-MM-DD. */
function ymdFromLocalParts(y: number, monthIndex: number, day: number): string {
  const m = String(monthIndex + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Week containing `dateYmd`: Sunday–Saturday in America/Chicago
 * (US restaurant convention). Documented in docs/DECISIONS.md.
 */
export function chicagoWeekBounds(dateYmd: string): {
  weekStart: string;
  weekEnd: string;
  rangeStart: Date;
  rangeEnd: Date;
} {
  const noon = fromZonedTime(`${dateYmd}T12:00:00`, TIMEZONE);
  const local = toZonedTime(noon, TIMEZONE);
  const dow = local.getDay(); // 0 = Sunday
  const sunday = new Date(local.getFullYear(), local.getMonth(), local.getDate() - dow);
  const saturday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 6);

  const weekStart = ymdFromLocalParts(
    sunday.getFullYear(),
    sunday.getMonth(),
    sunday.getDate(),
  );
  const weekEnd = ymdFromLocalParts(
    saturday.getFullYear(),
    saturday.getMonth(),
    saturday.getDate(),
  );

  return {
    weekStart,
    weekEnd,
    rangeStart: fromZonedTime(`${weekStart}T00:00:00`, TIMEZONE),
    rangeEnd: fromZonedTime(`${weekEnd}T23:59:59.999`, TIMEZONE),
  };
}

/** Minutes between two Date instants (assignment duration). */
export function assignmentMinutes(hourStart: Date, hourEnd: Date): number {
  const ms = hourEnd.getTime() - hourStart.getTime();
  return Math.max(0, Math.round(ms / 60_000));
}

/**
 * Aggregate assignment minutes for an employee in the Chicago week
 * containing `weekOfDate` (YYYY-MM-DD).
 */
export async function getEmployeeWeekHours(
  employeeId: string,
  weekOfDate: string,
): Promise<EmployeeHoursLedger | null> {
  const { prisma } = await import("@/lib/db");

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
  });
  if (!employee) return null;

  const { weekStart, weekEnd, rangeStart, rangeEnd } =
    chicagoWeekBounds(weekOfDate);

  const assignments = await prisma.assignment.findMany({
    where: {
      shift: { employeeId },
      hourStart: { gte: rangeStart, lte: rangeEnd },
    },
    include: { station: true },
  });

  const byStationMap = new Map<
    string,
    { stationId: string; stationLabel: string; minutes: number }
  >();

  for (const a of assignments) {
    const mins = assignmentMinutes(a.hourStart, a.hourEnd);
    const prev = byStationMap.get(a.stationId);
    if (prev) {
      prev.minutes += mins;
    } else {
      byStationMap.set(a.stationId, {
        stationId: a.stationId,
        stationLabel: a.station.label,
        minutes: mins,
      });
    }
  }

  const byStation: LedgerStationRow[] = [...byStationMap.values()]
    .map((r) => ({
      ...r,
      hours: Math.round((r.minutes / 60) * 100) / 100,
    }))
    .sort(
      (a, b) =>
        b.minutes - a.minutes || a.stationLabel.localeCompare(b.stationLabel),
    );

  const totalMinutes = byStation.reduce((s, r) => s + r.minutes, 0);

  return {
    employeeId: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    weekStart,
    weekEnd,
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 100) / 100,
    byStation,
  };
}
