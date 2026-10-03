import { formatInTimeZone } from "date-fns-tz";
import { Fragment, useState, type ReactNode } from "react";
import { isAuxiliaryPosition } from "@/lib/board/auxiliary";
import { TIMEZONE } from "@/lib/constants";
import { chicagoHourStart, formatCompactHour, hourGridHours } from "@/lib/hour-grid";
import { boardDisplayName, displayStationLabel, type Locale } from "@/lib/i18n";
import type { CoverSegment } from "@/lib/board/cover-display";
import { STATION_SHORT_CODES } from "@/lib/schedule/station-codes";
import { stationColorClass } from "./board-helpers";
import { clipSegment, isSplitDisplayHour, joinedDisplaySegments, savedHourSegments, type StationInterval } from "./cover-display";
import type { DayBoardDto } from "./types";
import { ShiftSourceRole } from "./ShiftSourceRole";

export const intervalLabel = (start: string, end: string) => `${formatInTimeZone(new Date(start), TIMEZONE, "h:mm a")}–${formatInTimeZone(new Date(end), TIMEZONE, "h:mm a")}`;
const unavailableLabel = (locale: Locale) => locale === "es" ? "Detalle de cobertura no disponible" : "Cover detail unavailable";
const COMPACT_STATION_CODES: Record<string, string> = { mana: "MGR", clean: "LIMP" };

function boxStationCode(day: DayBoardDto, station: NonNullable<CoverSegment["station"]>, locale: Locale) {
  const saved = station.shortCode?.trim() || day.stations.find(s => s.id === station.id)?.shortCode?.trim();
  // Compact fallbacks belong only to painter/Hora boxes; saved codes win.
  return saved || COMPACT_STATION_CODES[station.id] || STATION_SHORT_CODES[station.id] || displayStationLabel(locale, station);
}

/** Geometry uses exact minute bounds, including factual partial shift minutes. */
export function SavedHour({ day, hour, segments, locale, emptyLabel = "·", minute = 0, minutes = 60, splitHour, compactLabels = false, mergeSegments = minutes === 60 }: { day: DayBoardDto; hour: number; segments: CoverSegment[]; locale: Locale; emptyLabel?: string; minute?: number; minutes?: number; splitHour?: boolean; compactLabels?: boolean; mergeSegments?: boolean }) {
  const hourStart = +chicagoHourStart(day.date, hour), start = hourStart + minute * 60_000;
  const display = compactLabels ? (mergeSegments ? joinedDisplaySegments(segments) : segments)
    .flatMap(s => { const part = clipSegment(s, start, start + minutes * 60_000); return part ? [part] : []; }) : segments;
  const split = splitHour ?? isSplitDisplayHour(display, hourStart, hourStart + 3_600_000);
  return <span className="relative block h-14 w-full min-w-0 bg-white text-neutral-950" data-testid="saved-hour" data-hour={hour}>
    {display.map((s, index) => {
      const away = s.kind === "cover" && s.station?.board !== day.board;
      const station = s.station ? displayStationLabel(locale, s.station) : emptyLabel;
      const destination = s.station && s.station.board !== day.board ? `${boardDisplayName(locale, s.station.board === "caja" ? "caja" : "cocina")} · ${station}` : station;
      const label = s.kind === "break" ? "BREAK" : away ? `${locale === "es" ? "Fuera" : "Away"} → ${destination}` : s.kind === "cover" ? `${locale === "es" ? "Cubre" : "Cover"} · ${destination}` : destination;
      const code = s.station ? boxStationCode(day, s.station, locale) : emptyLabel;
      const compact = s.kind === "break" ? "BREAK" : away ? `→ ${code}` : s.kind === "cover" ? `${locale === "es" ? "Cubre" : "Cover"} · ${code}` : code;
      const time = intervalLabel(s.startAt, s.endAt);
      return <span key={index} data-testid={s.kind === "break" ? "break-stripe" : undefined} data-break={s.kind === "break" ? time.replace("–", "-") : undefined} data-kind={s.kind} data-away={away ? "1" : "0"} data-start={s.startAt} data-end={s.endAt}
        className={`absolute inset-y-0 flex min-w-0 flex-col justify-center overflow-hidden border border-neutral-500 px-0.5 text-center text-[10px] font-bold leading-tight ${s.kind === "break" ? "bg-neutral-950 text-white" : away ? "bg-neutral-200 text-neutral-950" : s.station ? stationColorClass(s.station.color) : "bg-amber-50 text-neutral-950"}`}
        style={{ left: `${(Date.parse(s.startAt) - start) / (minutes * 600)}%`, width: `${(Date.parse(s.endAt) - Date.parse(s.startAt)) / (minutes * 600)}%` }} title={`${label} · ${time}`} aria-label={`${label} · ${time}`}>
        <span className={compactLabels ? "break-words" : undefined} data-testid="saved-box-label">{compactLabels ? split || minutes < 60 ? compact : label : label}</span>
        {compactLabels ? split && Date.parse(s.endAt) - Date.parse(s.startAt) > 15 * 60_000 && <span className="mt-0.5 whitespace-nowrap text-[8px]" data-testid="saved-box-time">{formatInTimeZone(new Date(s.startAt), TIMEZONE, "mm")}–{formatInTimeZone(new Date(s.endAt), TIMEZONE, "mm")}</span> : <span className="mt-0.5 text-[9px]">{time}</span>}
        {s.auto && <span>auto</span>}

      </span>;
    })}
  </span>;
}

export function SavedShiftHour({ day, shiftId, hour, locale }: { day: DayBoardDto; shiftId: string; hour: number; locale: Locale }) {
  const segments = savedHourSegments(day, shiftId, hour);
  return segments ? <SavedHour day={day} hour={hour} segments={segments} locale={locale} /> : null;
}

export function SavedStationOccupants({ rows, locale, wall = false, renderPerson }: { rows: StationInterval[]; locale: Locale; date: string; hour: number; wall?: boolean; renderPerson?: (row: StationInterval) => ReactNode }) {
  return <span className={`block space-y-1 font-bold ${wall ? "text-4xl md:text-5xl" : "text-sm"}`} data-testid="saved-station-occupants">
    {rows.length ? rows.filter((r, i) => rows.findIndex(other => other.employeeId === r.employeeId && other.shiftId === r.shiftId && other.cover === r.cover) === i).map((r, i) => <span key={i} className="block rounded border border-neutral-700 bg-white px-2 py-1 text-neutral-950" data-employee={r.employeeId} data-start={r.startAt} data-end={r.endAt}>
      <span className="block" data-testid="saved-station-name">{renderPerson ? renderPerson(r) : <>{r.name}{r.cover ? ` · ${locale === "es" ? "Cubre" : "Cover"}` : ""}</>}</span>

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
export function SavedCoverRows({ day, locale, hours, leadingColumns = 1, includePrimary = false, quarterGuides = false, nameCellClassName = "", interactiveDetails = false, compactLabels = false }: {
  day: DayBoardDto; locale: Locale; hours: number[]; leadingColumns?: 1 | 2; includePrimary?: boolean; quarterGuides?: boolean; nameCellClassName?: string; interactiveDetails?: boolean; compactLabels?: boolean;
}) {
  const [inspected, setInspected] = useState<string | null>(null);
  const detailLabel = locale === "es" ? "Ver cobertura" : "View cover";
  return <>{coverTracks(day, includePrimary).map(track => <Fragment key={track.shiftId}><tr data-testid={`cover-row-${track.shiftId}`}>
    <th className={`sticky left-0 z-10 border-y border-neutral-300 bg-white px-2 py-1 text-left text-sm font-bold text-neutral-950 ${nameCellClassName}`} scope="row">
      {interactiveDetails ? <button type="button" className="min-h-11 w-full text-left underline" data-testid={`cover-detail-open-${track.shiftId}`}
        aria-label={`${detailLabel} · ${track.firstName} ${track.lastName}`} aria-expanded={inspected === track.shiftId}
        onFocus={() => setInspected(track.shiftId)} onClick={() => setInspected(track.shiftId)}>{track.firstName} {track.lastName}</button> : <>{track.firstName} {track.lastName}</>}
      <span className="block text-[10px] font-normal">{locale === "es" ? "Cobertura guardada" : "Saved cover"}</span>
      <ShiftSourceRole shiftId={track.shiftId} position={track.sourcePosition} locale={locale}/>
    </th>
    {leadingColumns === 2 && <td className="border-y border-neutral-300 bg-white px-1 text-center text-[10px] text-neutral-950">{intervalLabel(track.startAt, track.endAt)}</td>}
    {hours.map(hour => {
      const start = +chicagoHourStart(day.date, hour);
      const segments = (compactLabels && !quarterGuides ? joinedDisplaySegments(track.segments) : track.segments).flatMap(s => { const clip = clipSegment(s, start, start + 3600000); return clip ? [clip] : []; });
      const auxiliary = isAuxiliaryPosition(track.sourcePosition) || (track.board !== "caja" && track.board !== "cocina");
      const content = <SavedHour day={day} hour={hour} segments={segments} locale={locale} compactLabels={compactLabels} mergeSegments={!quarterGuides} emptyLabel={auxiliary ? locale === "es" ? "REFUERZO" : "BACKUP" : "·"} />;
      return <td key={hour} className="relative border border-neutral-300 p-0.5">{interactiveDetails && segments.length ?
        <button type="button" className={compactLabels ? "absolute inset-0 block h-full w-full p-0 text-left [&>[data-testid=saved-hour]]:h-full" : "block min-h-11 w-full p-0 text-left"} data-testid={`cover-hour-detail-${track.shiftId}-${hour}`} aria-label={`${detailLabel} · ${track.firstName} ${track.lastName} · ${formatCompactHour(hour)}`}
          onFocus={() => setInspected(track.shiftId)} onClick={() => setInspected(track.shiftId)}>{content}</button> : content}
        {quarterGuides && [25, 50, 75].map(left => <span key={left} aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-dashed border-neutral-400" style={{left: `${left}%`}} />)}</td>;
    })}
  </tr>{interactiveDetails && inspected === track.shiftId && <tr><td colSpan={hours.length + leadingColumns}>
    <div className="sticky left-0 my-2 rounded border-2 border-neutral-700 bg-white p-3 text-left text-sm text-neutral-950" style={{ width: "min(36rem, calc(100vw - 64px))" }}
      data-testid={`cover-detail-${track.shiftId}`} aria-live="polite">
      <strong>{track.firstName} {track.lastName}</strong>
      {track.segments.map((s, index) => <p key={index} data-start={s.startAt} data-end={s.endAt}>
        {s.kind === "break" ? "BREAK" : `${s.kind === "cover" ? locale === "es" ? "Cubre · " : "Cover · " : ""}${s.station ? `${boardDisplayName(locale, s.station.board === "caja" ? "caja" : "cocina")} · ${displayStationLabel(locale, s.station)}` : s.kind === "cover" ? locale === "es" ? "REFUERZO" : "BACKUP" : locale === "es" ? "Sin pintar" : "Unpainted"}`} · {intervalLabel(s.startAt, s.endAt)}
      </p>)}
      <button type="button" className="mt-2 min-h-11 rounded border-2 border-neutral-700 px-3 font-bold" onClick={() => setInspected(null)}>{locale === "es" ? "Cerrar" : "Close"}</button>
    </div>
  </td></tr>}</Fragment>)}</>;
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
