import { chicagoHourStart, hourGridHours } from "@/lib/hour-grid";
import { NIEVES_POSITION, subtractWindows } from "@/lib/import/nieves";
import type { Locale } from "@/lib/i18n";
import { intervalLabel } from "./SavedCoverDisplay";
import { displayName } from "./board-helpers";
import type { DayBoardDto } from "./types";

/** Report current facts, including deliberate blanks; never call them omissions. */
export function nievesUnassigned(day: DayBoardDto) {
  const hours = hourGridHours(), gridStart = +chicagoHourStart(day.date, hours[0]);
  const gridEnd = +chicagoHourStart(day.date, hours[hours.length - 1]) + 3_600_000;
  return day.shifts.filter(s => s.sourcePosition === NIEVES_POSITION && !s.supersededAt).flatMap(shift => {
    const track = day.coverDisplay?.tracks.find(t => t.shiftId === shift.id);
    const occupied = track ? track.segments.filter(s => s.kind !== "work" || s.station !== null)
      .map(s => ({ startMs: Date.parse(s.startAt), endMs: Date.parse(s.endAt) }))
      : shift.paintHours ? shift.paintHours.flatMap(h => h.intervals.filter(i => i.state === "assigned")
        .map(i => ({ startMs: Date.parse(i.startAt), endMs: Date.parse(i.endAt) })))
      : shift.assignments.map(a => ({ startMs: Date.parse(a.hourStart), endMs: Date.parse(a.hourEnd) }));
    return subtractWindows({ startMs: Math.max(gridStart, Date.parse(shift.startAt)), endMs: Math.min(gridEnd, Date.parse(shift.endAt)) }, occupied)
      .map(interval => ({ shift, startAt: new Date(interval.startMs).toISOString(), endAt: new Date(interval.endMs).toISOString() }));
  });
}

export function NievesUnassigned({ day, locale }: { day: DayBoardDto; locale: Locale }) {
  const rows = nievesUnassigned(day);
  if (!rows.length) return null;
  return <div className="my-2 rounded border border-amber-700 bg-amber-50 p-2 text-sm text-amber-950" data-testid="nieves-unassigned">
    <strong>{locale === "es" ? "Nieves · sin asignar" : "Nieves · unassigned"}</strong>
    {rows.map(r => <p key={`${r.shift.id}:${r.startAt}`} data-shift={r.shift.id} data-start={r.startAt} data-end={r.endAt}>
      {displayName(r.shift)} · {intervalLabel(r.startAt, r.endAt)}
    </p>)}
  </div>;
}
