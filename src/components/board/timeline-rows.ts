import { chicagoHourOf } from "@/lib/hour-grid";
import type { ShiftDto } from "./types";

export type TimelineCell = {
  kind: "off" | "open" | "seated";
  stationId: string | null;
  label: string;
  changedFromPrev: boolean;
};

export type TimelineRow = {
  shift: ShiftDto;
  cells: TimelineCell[];
  /** True on a person's second and later shift of the day; the row shows its start. */
  laterShiftOfPerson: boolean;
};

export function personName(sh: ShiftDto): string {
  return `${sh.employee.firstName} ${sh.employee.lastName}`.trim();
}

function shiftCoversHour(sh: ShiftDto, date: string, hour: number): boolean {
  if (sh.date !== date) return false;
  const startH = chicagoHourOf(new Date(sh.startAt));
  const endH = chicagoHourOf(new Date(sh.endAt));
  // endAt exclusive by hour bucket when minutes=0; treat end hour exclusive
  const endExclusive =
    new Date(sh.endAt).getMinutes() === 0 &&
    new Date(sh.endAt).getSeconds() === 0
      ? endH
      : endH + 1;
  return hour >= startH && hour < endExclusive;
}

function stationAtHour(
  sh: ShiftDto,
  date: string,
  hour: number,
): string | null {
  const hit = sh.assignments.find((a) => {
    const h = chicagoHourOf(new Date(a.hourStart));
    return sh.date === date && h === hour;
  });
  return hit?.stationId ?? null;
}

/**
 * One row per shift: a split shift shows as two rows of the same person,
 * sorted by person then start. Later rows carry their start time.
 */
export function buildTimelineRows(opts: {
  shifts: ShiftDto[];
  date: string;
  hours: number[];
  offLabel: string;
  unassignedLabel: string;
  stationLabelFor: (stationId: string) => string;
}): TimelineRow[] {
  const { date, hours } = opts;
  const startMs = (sh: ShiftDto) => new Date(sh.startAt).getTime();
  const sorted = opts.shifts
    .filter((sh) => sh.date === date)
    .sort(
      (a, b) =>
        personName(a).localeCompare(personName(b)) ||
        a.employee.id.localeCompare(b.employee.id) ||
        startMs(a) - startMs(b) ||
        a.id.localeCompare(b.id),
    );
  const seen = new Set<string>();
  return sorted.map((sh) => {
    const laterShiftOfPerson = seen.has(sh.employee.id);
    seen.add(sh.employee.id);
    const cells: TimelineCell[] = hours.map((hour, idx) => {
      if (!shiftCoversHour(sh, date, hour)) {
        return { kind: "off", stationId: null, label: opts.offLabel, changedFromPrev: false };
      }
      const stationId = stationAtHour(sh, date, hour);
      const prevHour = hours[idx - 1];
      const prevId =
        prevHour != null && shiftCoversHour(sh, date, prevHour)
          ? stationAtHour(sh, date, prevHour)
          : null;
      if (!stationId) {
        return {
          kind: "open",
          stationId: null,
          label: opts.unassignedLabel,
          changedFromPrev: prevId != null,
        };
      }
      return {
        kind: "seated",
        stationId,
        label: opts.stationLabelFor(stationId),
        changedFromPrev: prevId != null && prevId !== stationId,
      };
    });
    return { shift: sh, cells, laterShiftOfPerson };
  });
}
