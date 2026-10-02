import { formatInTimeZone } from "date-fns-tz";
import type { ReactNode } from "react";
import { isAuxiliaryPosition } from "@/lib/board/auxiliary";
import { TIMEZONE } from "@/lib/constants";
import { chicagoHourStart, formatCompactHour, hourGridHours } from "@/lib/hour-grid";
import { boardDisplayName, displayStationLabel, type Locale } from "@/lib/i18n";
import type { CoverSegment } from "@/lib/board/cover-display";
import { stationColorClass } from "./board-helpers";
import { clipSegment, savedHourSegments, type StationInterval } from "./cover-display";
import type { DayBoardDto } from "./types";

export const intervalLabel = (start: string, end: string) => `${formatInTimeZone(new Date(start), TIMEZONE, "h:mm a")}–${formatInTimeZone(new Date(end), TIMEZONE, "h:mm a")}`;
const unavailableLabel = (locale: Locale) => locale === "es" ? "Detalle de cobertura no disponible" : "Cover detail unavailable";

/** Geometry uses exact minute bounds, including factual partial shift minutes. */
export function SavedHour({ day, hour, segments, locale, emptyLabel = "·", minute = 0, minutes = 60 }: { day: DayBoardDto; hour: number; segments: CoverSegment[]; locale: Locale; emptyLabel?: string; minute?: number; minutes?: number }) {
  const start = +chicagoHourStart(day.date, hour) + minute * 60_000;
  return <span className="relative block h-14 w-full min-w-0 bg-white text-neutral-950" data-testid="saved-hour" data-hour={hour}>
    {segments.map((s, index) => {
      const away = s.kind === "cover" && s.station?.board !== day.board;
      const station = s.station ? displayStationLabel(locale, s.station) : emptyLabel;
      const destination = s.station && s.station.board !== day.board ? `${boardDisplayName(locale, s.station.board === "caja" ? "caja" : "cocina")} · ${station}` : station;
      const label = s.kind === "break" ? "BREAK" : away ? `${locale === "es" ? "Fuera" : "Away"} → ${destination}` : s.kind === "cover" ? `${locale === "es" ? "Cubre" : "Cover"} · ${destination}` : destination;
      const time = intervalLabel(s.startAt, s.endAt);
      return <span key={index} data-testid={s.kind === "break" ? "break-stripe" : undefined} data-break={s.kind === "break" ? time.replace("–", "-") : undefined} data-kind={s.kind} data-away={away ? "1" : "0"} data-start={s.startAt} data-end={s.endAt}
        className={`absolute inset-y-0 flex min-w-0 flex-col justify-center overflow-hidden border border-neutral-500 px-0.5 text-center text-[10px] font-bold leading-tight ${s.kind === "break" ? "bg-neutral-950 text-white" : away ? "bg-neutral-200 text-neutral-950" : s.station ? stationColorClass(s.station.color) : "bg-amber-50 text-neutral-950"}`}
        style={{ left: `${(Date.parse(s.startAt) - start) / (minutes * 600)}%`, width: `${(Date.parse(s.endAt) - Date.parse(s.startAt)) / (minutes * 600)}%` }} title={`${label} · ${time}`} aria-label={`${label} · ${time}`}>
        <span>{label}</span><span className="mt-0.5 text-[9px]">{time}</span>{s.auto && <span>auto</span>}
      </span>;
    })}
  </span>;
}

export function SavedShiftHour({ day, shiftId, hour, locale }: { day: DayBoardDto; shiftId: string; hour: number; locale: Locale }) {
  const segments = savedHourSegments(day, shiftId, hour);
  return segments ? <SavedHour day={day} hour={hour} segments={segments} locale={locale} /> : null;
}

export function SavedStationOccupants({ rows, locale, date, hour, wall = false, renderPerson }: { rows: StationInterval[]; locale: Locale; date: string; hour: number; wall?: boolean; renderPerson?: (row: StationInterval) => ReactNode }) {
  const start = +chicagoHourStart(date, hour);
  return <span className={`block space-y-1 font-bold ${wall ? "text-4xl md:text-5xl" : "text-sm"}`} data-testid="saved-station-occupants">
    {rows.length ? rows.map((r, i) => <span key={i} className="block rounded border border-neutral-700 bg-white px-2 py-1 text-neutral-950" data-employee={r.employeeId} data-start={r.startAt} data-end={r.endAt}>
      <span className="block" data-testid="saved-station-name">{renderPerson ? renderPerson(r) : <>{r.name}{r.cover ? ` · ${locale === "es" ? "Cubre" : "Cover"}` : ""}</>}</span>
      <span className={`block ${wall ? "text-lg md:text-xl" : "text-xs"}`}>{intervalLabel(r.startAt, r.endAt)}</span>
      <span className="relative mt-1 block h-2 bg-neutral-200"><span className="absolute inset-y-0 bg-neutral-900" data-testid="station-interval"
        style={{ left: `${(Date.parse(r.startAt) - start) / 36000}%`, width: `${(Date.parse(r.endAt) - Date.parse(r.startAt)) / 36000}%` }} /></span>
    </span>) : <span>{locale === "es" ? "Sin persona" : "Empty"}</span>}
  </span>;
}

/** Rendering a row never adds a primary shift or changes headcounts. */
function coverTracks(day: DayBoardDto, includePrimary: boolean) {
  return (day.coverDisplay?.tracks ?? []).filter(t => (includePrimary || !day.shifts.some(s => s.id === t.shiftId))
    && t.segments.some(s => (includePrimary && s.kind === "break" && t.board === day.board)
      || (s.kind === "cover" && (s.station?.board === day.board || s.fromStation?.board === day.board || t.board === day.board))));
}

/** Insert into the existing time table, so its hour boundaries remain aligned. */
export function SavedCoverRows({ day, locale, hours, leadingColumns = 1, includePrimary = false, quarterGuides = false, nameCellClassName = "" }: {
  day: DayBoardDto; locale: Locale; hours: number[]; leadingColumns?: 1 | 2; includePrimary?: boolean; quarterGuides?: boolean; nameCellClassName?: string;
}) {
  return <>{coverTracks(day, includePrimary).map(track => <tr key={track.shiftId} data-testid={`cover-row-${track.shiftId}`}>
    <th className={`sticky left-0 z-10 border-y border-neutral-300 bg-white px-2 py-1 text-left text-sm font-bold text-neutral-950 ${nameCellClassName}`} scope="row">
      {track.firstName} {track.lastName}<span className="block text-[10px] font-normal">{locale === "es" ? "Cobertura guardada" : "Saved cover"}</span>
    </th>
    {leadingColumns === 2 && <td className="border-y border-neutral-300 bg-white px-1 text-center text-[10px] text-neutral-950">{intervalLabel(track.startAt, track.endAt)}</td>}
    {hours.map(hour => {
      const start = +chicagoHourStart(day.date, hour);
      const segments = track.segments.flatMap(s => { const clip = clipSegment(s, start, start + 3600000); return clip ? [clip] : []; });
      const auxiliary = isAuxiliaryPosition(track.sourcePosition) || (track.board !== "caja" && track.board !== "cocina");
      return <td key={hour} className="relative border border-neutral-300 p-0.5"><SavedHour day={day} hour={hour} segments={segments} locale={locale} emptyLabel={auxiliary ? locale === "es" ? "REFUERZO" : "BACKUP" : "·"} />{quarterGuides && [25, 50, 75].map(left => <span key={left} aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-dashed border-neutral-400" style={{left: `${left}%`}} />)}</td>;
    })}
  </tr>)}</>;
}

/** Notices plus a stand-alone grid where no primary time table is mounted. */
export function SavedCoverPanel({ day, locale, hours = hourGridHours(), rows = true, includePrimary = false }: {
  day: DayBoardDto; locale: Locale; hours?: number[]; rows?: boolean; includePrimary?: boolean;
}) {
  const tracks = rows ? coverTracks(day, includePrimary) : [];
  const missing = day.coverDisplay?.unavailable ?? [];
  const old = !day.coverDisplay && (day.breaks ?? []).some(b => b.coverEmployeeId);
  if (!tracks.length && !missing.length && !old) return null;
  return <section className="my-2 rounded border-2 border-neutral-500 bg-white p-2 text-neutral-950" data-testid="saved-cover-panel">
    <h3 className="text-sm font-bold">{locale === "es" ? "Coberturas guardadas" : "Saved covers"}</h3>
    {old && <p role="status">{unavailableLabel(locale)}</p>}
    {missing.map(b => <p role="status" key={b.id}>{`${b.firstName} ${b.lastName}`.trim()} · {intervalLabel(b.startAt, b.endAt)} · {unavailableLabel(locale)}</p>)}
    {tracks.length > 0 && <div className="overflow-x-auto"><table className="min-w-full border-collapse text-xs"><thead><tr><th className="sticky left-0 z-10 min-w-36 bg-white text-left">{locale === "es" ? "Persona" : "Person"}</th>{hours.map(h => <th key={h} className="min-w-[9rem]">{formatCompactHour(h)}</th>)}</tr></thead>
      <tbody><SavedCoverRows day={day} locale={locale} hours={hours} includePrimary={includePrimary} /></tbody></table></div>}
  </section>;
}
