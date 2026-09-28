import { chicagoHourEnd, chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";

/** Cocina stations that are mandatory every day. They cannot be unmarked. Caja has none. */
export const MANDATORY_STATIONS = ["pdf_tq1r", "pdf_tf1r", "pdf_pr1e"] as const;

/** A gap counts from 11:00 through the last grid hour. Earlier hours are never gaps. */
export const MANDATORY_GAP_START = 11;

export function isDefaultMandatory(stationId: string): boolean {
  return (MANDATORY_STATIONS as readonly string[]).includes(stationId);
}

export function mandatoryGapLabel(station: { shortCode?: string | null; label: string }): string {
  const code = station.shortCode?.trim();
  return code ? code : station.label;
}

export type MandatoryGapShift = {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  supersededAt?: string | null;
  assignments: { stationId: string; hourStart: string }[];
};

export type MandatoryGapDraft = {
  shiftId: string;
  hour: number;
  stationId: string | null;
};

export type MandatoryGap = { stationId: string; hour: number };

function savedStation(shift: MandatoryGapShift, date: string, hour: number): string | null {
  const hit = shift.assignments.find((assignment) => {
    return shift.date === date && chicagoHourOf(new Date(assignment.hourStart)) === hour;
  });
  return hit?.stationId ?? null;
}

/** Same on/off rule the paint matrix uses for a cell. */
function hourIsOnMatrix(shift: MandatoryGapShift, date: string, hour: number): boolean {
  if (shift.date !== date) return false;
  if (shift.supersededAt) return savedStation(shift, date, hour) != null;
  return isHourInShift(
    chicagoHourStart(date, hour),
    new Date(shift.startAt),
    new Date(shift.endAt),
    chicagoHourEnd(date, hour),
  );
}

/**
 * Uncovered mandatory stations. Hours before 11 are never gaps.
 * A pending draft replaces the saved station on a cell the matrix shows.
 * A person at Taquero 2 does not cover Taquero 1.
 */
export function uncoveredMandatory(input: {
  stationIds: readonly string[];
  hours: readonly number[];
  date: string;
  shifts: readonly MandatoryGapShift[];
  drafts?: readonly MandatoryGapDraft[];
}): MandatoryGap[] {
  const gapHours = input.hours.filter((hour) => hour >= MANDATORY_GAP_START);
  const drafts = new Map<string, string | null>(
    (input.drafts ?? []).map((draft) => [`${draft.shiftId}|${draft.hour}`, draft.stationId]),
  );
  const occupied = new Set<string>();
  for (const shift of input.shifts) {
    for (const hour of gapHours) {
      if (!hourIsOnMatrix(shift, input.date, hour)) continue;
      const draftKey = `${shift.id}|${hour}`;
      const stationId = drafts.has(draftKey) ? drafts.get(draftKey) ?? null : savedStation(shift, input.date, hour);
      if (stationId) occupied.add(`${stationId}|${hour}`);
    }
  }
  const gaps: MandatoryGap[] = [];
  for (const stationId of input.stationIds) {
    for (const hour of gapHours) {
      if (!occupied.has(`${stationId}|${hour}`)) gaps.push({ stationId, hour });
    }
  }
  return gaps;
}
