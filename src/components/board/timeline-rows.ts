import { chicagoHourEnd, chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";
import type { ShiftDto } from "./types";

export type TimelineCell = {
  kind: "off" | "open" | "seated";
  stationId: string | null;
  label: string;
  changedFromPrev: boolean;
};

export type TimelineRow = {
  shift: ShiftDto;
  /** Superseded by a newer import: only its assigned (history) hours show. */
  ended: boolean;
  cells: TimelineCell[];
  /** True on a person's second and later shift of the day; the row shows its start. */
  laterShiftOfPerson: boolean;
};

export function personName(sh: ShiftDto): string {
  return `${sh.employee.firstName} ${sh.employee.lastName}`.trim();
}

function shiftCoversHour(sh: ShiftDto, date: string, hour: number): boolean {
  if (sh.date !== date) return false;
  if (sh.supersededAt) return stationAtHour(sh, date, hour) != null;
  return isHourInShift(
    chicagoHourStart(date, hour),
    new Date(sh.startAt),
    new Date(sh.endAt),
    chicagoHourEnd(date, hour),
  );
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
    // Ended history rows carry their own marker and do not make a live shift "later".
    const laterShiftOfPerson = !sh.supersededAt && seen.has(sh.employee.id);
    if (!sh.supersededAt) seen.add(sh.employee.id);
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
    return { shift: sh, cells, laterShiftOfPerson, ended: Boolean(sh.supersededAt) };
  });
}
