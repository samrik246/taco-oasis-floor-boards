"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chicagoHourStart, formatHourLabel, hourGridHours } from "@/lib/hour-grid";
import { scheduledIntervalHeadcounts } from "@/lib/board/headcounts";
import { hourEditRefusal, quarterEditRefusal } from "@/lib/quarter/client/edit";
import type { RetainedIntent } from "@/lib/quarter/client/draft-types";
import type { Locale } from "@/lib/i18n";
import { PAINT_FAMILIES, PAINT_FAMILY_LABELS } from "@/lib/assignments/paint-families";
import { displayStationLabel } from "@/lib/i18n";
import { displayName, stationColorClass } from "./board-helpers";
import { clipSegment, isSplitDisplayHour, savedHourSegments } from "./cover-display";
import { SavedCoverRows, SavedHour, intervalLabel } from "./SavedCoverDisplay";
import type { DayBoardDto, ShiftDto } from "./types";
import styles from "./QuarterGrid.module.css";
import { CellFeedback } from "./CellFeedback";
import { ShiftSourceRole } from "./ShiftSourceRole";
import { NievesUnassigned } from "./NievesUnassigned";

export type GridCell = { shiftId: string; hour: number; minute: 0 | 15 | 30 | 45 | null };
export type GridCellError = GridCell & { code: string };
export type GridNotice = GridCellError & { errors?: GridCellError[] };
const cellId = (cell: GridCell) => `quarter-cell-${cell.shiftId}-${cell.hour}${cell.minute === null ? "" : `-${cell.minute}`}`;
const hours = hourGridHours(), quarters = [0, 15, 30, 45] as const;
const nameWidth = 176, overviewWidth = 100;
export function quarterExplanation(code: string, es: boolean): string {
  const messages: Record<string, [string, string]> = {
    HOUR_NEEDS_QUARTER: ["Mixed hour: open quarters to change just the intended interval.", "Hora mixta: abre los cuartos para cambiar solo el intervalo deseado."],
    QUARTER_DRAFT_REVIEW_ONLY: ["This hour has private quarter changes. Open quarters to keep them separate.", "Esta hora tiene cambios privados por cuartos. Abre los cuartos para conservarlos separados."],
    HOUR_HAS_OBLIGATION: ["This hour contains a saved BREAK or movement. Open quarters to choose an unaffected interval.", "Esta hora tiene un BREAK o movimiento guardado. Abre los cuartos para elegir un intervalo libre."],
    QUARTER_HAS_OBLIGATION: ["This quarter contains a saved BREAK or movement. Review that movement before painting.", "Este cuarto tiene un BREAK o movimiento guardado. Revisa ese movimiento antes de pintar."],
    SOURCE_NOT_AVAILABLE: ["Outside the available shift.", "Fuera del turno disponible."],
    STATION_FULL: ["The station is occupied in this interval. Your private draft is retained.", "La estación está ocupada en este intervalo. Tu borrador privado se conserva."],
    QUARTER_UI_UNAVAILABLE: ["Quarter editing is unavailable in the current version. Retained work is preserved.", "La edición por cuartos no está disponible en la versión actual. Los borradores se conservan."],
  };
  return messages[code]?.[es ? 1 : 0] ?? code;
}

type Props = {
  day: DayBoardDto; locale: Locale; selectedHour: number; onSelectHour?: (hour: number) => void;
  personControls?: (shift: ShiftDto) => ReactNode;
  intents?: RetainedIntent[]; disabled?: boolean; hasChoice?: boolean;
  onPaint?: (cells: GridCell[]) => Promise<void>;
  notice?: GridNotice | null; onNotice?: (notice: GridNotice | null) => void;
};

/** One hour column in both views. Only its width changes, so rows and cover identities stay aligned. */
export function QuarterGrid({ day, locale, selectedHour, onSelectHour, personControls, intents = [], disabled = false, hasChoice = false, onPaint, notice, onNotice }: Props) {
  const es = locale === "es", [zoom, setZoom] = useState(false);
  const [inspected, setInspected] = useState<GridCell | null>(null);
  const scroller = useRef<HTMLDivElement>(null), centerRequested = useRef(false);
  const drag = useRef<GridCell[]>([]), suppressClick = useRef(false);
  const pointerInspection = useRef<HTMLButtonElement | null>(null);
  const hourWidth = overviewWidth * (zoom ? 4 : 1);
  const slots = useMemo(() => hours.flatMap(hour => zoom ? quarters.map(minute => ({ hour, minute, minutes: 15 })) : [{ hour, minute: 0, minutes: 60 }]), [zoom]);
  const counts = useMemo(() => scheduledIntervalHeadcounts(day, slots), [day, slots]);
  useLayoutEffect(() => {
    if (!centerRequested.current || !scroller.current) return;
    const el = scroller.current, index = hours.indexOf(selectedHour);
    if (index >= 0) el.scrollLeft = nameWidth + (index + 0.5) * hourWidth - (el.clientWidth + nameWidth) / 2;
    centerRequested.current = false;
  }, [zoom, selectedHour, hourWidth]);
  // Cancel outside the grid as well; an abandoned gesture never paints later.
  useEffect(() => {
    const clearInspection = () => { pointerInspection.current = null; };
    const cancel = () => { drag.current = []; clearInspection(); };
    const release = (event: PointerEvent) => {
      drag.current = [];
      if (!(event.target instanceof Node) || !pointerInspection.current?.contains(event.target)) clearInspection();
    };
    window.addEventListener("pointerup", release); window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel); window.addEventListener("keydown", clearInspection, true);
    return () => {
      window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel); window.removeEventListener("keydown", clearInspection, true);
    };
  }, []);
  function select(hour: number) { onSelectHour?.(hour); }
  function openQuarters(hour: number) { select(hour); centerRequested.current = true; setZoom(true); onNotice?.(null); }
  function refusal(cell: GridCell) {
    const publicDay = day.quarter;
    if (!publicDay) return "QUARTER_NOT_ACTIVE";
    if (cell.minute !== null) return quarterEditRefusal(publicDay, cell.shiftId, cell.hour, cell.minute);
    return hourEditRefusal(publicDay, cell.shiftId, cell.hour) ?? (intents.some(i => i.intent.shiftId === cell.shiftId && Number(i.intent.quarter.slice(0, 2)) === cell.hour && i.intent.granularity !== "hour") ? "QUARTER_DRAFT_REVIEW_ONLY" : null);
  }
  async function paint(cells: GridCell[]) {
    if (disabled || !onPaint) return;
    const errors = cells.flatMap(cell => { const code = refusal(cell); return code ? [{ ...cell, code }] : []; });
    if (errors.length) { onNotice?.({ ...errors[0], errors }); return; }
    if (!hasChoice) return;
    select(cells.at(-1)!.hour); onNotice?.(null); await onPaint(cells);
  }
  return <><NievesUnassigned day={day} locale={locale}/>
    {notice && <details open className="rounded border-2 border-amber-800 bg-amber-50 p-2 text-sm text-amber-950" data-testid="q1-error-summary">
      <summary className="min-h-11 cursor-pointer font-bold">{es ? "Cambios sin aplicar" : "Changes not applied"} ({notice.errors?.length ?? 1})</summary>
      <ul>{(notice.errors ?? [notice]).map(error => <li key={cellId(error)}><button type="button" className="min-h-11 text-left underline" onClick={() => {
        const cell = document.getElementById(cellId(error)); cell?.scrollIntoView({ block: "center", inline: "center" }); cell?.focus({ preventScroll: true }); onNotice?.({ ...error, errors: notice.errors });
      }}>{day.shifts.find(shift => shift.id === error.shiftId)?.employee.firstName} · {formatHourLabel(error.hour)}{error.minute !== null ? ` · :${String(error.minute).padStart(2, "0")}` : ""}: {quarterExplanation(error.code, es)}</button></li>)}</ul>
    </details>}
    <div ref={scroller} className={styles.scroller} data-testid="q1-grid-scroll" data-zoom={zoom ? "quarter" : "hour"}>
    <table className={styles.grid} style={{ width: nameWidth + hours.length * hourWidth }} data-testid="q1-grid">
      <colgroup><col style={{ width: nameWidth }} />{hours.map(h => <col key={h} style={{ width: hourWidth }} />)}</colgroup>
      <thead><tr data-testid="q1-headcount-row">
        <th className={styles.person}><span>{es ? "Persona" : "Person"}</span><span className="block text-xs">{es ? "Personal programado" : "Scheduled workers"}</span>
          <button type="button" data-testid="q1-zoom" className="min-h-11 rounded border border-blue-700 px-2 text-sm font-bold text-blue-800" aria-pressed={zoom} onClick={() => { centerRequested.current = true; setZoom(!zoom); onNotice?.(null); }}>{es ? zoom ? "Horas completas" : "Dividir hora" : zoom ? "Whole hours" : "Split hour"}</button>
        </th>
        {hours.map((hour, index) => <th key={hour} scope="col" data-testid={`q1-hour-header-${hour}`}>
          <button type="button" className="min-h-11 w-full whitespace-nowrap font-bold" aria-pressed={selectedHour === hour} onClick={() => { centerRequested.current = zoom; select(hour); }}>
            {formatHourLabel(hour)}{!zoom && <> · <span data-testid={`q1-count-${hour}-0`}><strong aria-label={`${es ? "Personal programado" : "Scheduled workers"}: ${counts[index]}`}>{counts[index]}</strong></span></>}
          </button>
          {zoom && <div className="flex">{quarters.map((minute, q) => <span key={minute} className={styles.count} style={{ width: "25%" }} data-testid={`q1-count-${hour}-${minute}`}>
            <span className="block text-[10px]">:{String(minute).padStart(2, "0")}</span><strong aria-label={`${es ? "Personal programado" : "Scheduled workers"}: ${counts[index * 4 + q]}`}>{counts[index * 4 + q]}</strong>
          </span>)}</div>}

        </th>)}
      </tr></thead>
      <tbody>{day.shifts.map(shift => <tr key={shift.id} data-testid={`q1-row-${shift.id}`}>
        <th className={styles.person} scope="row"><span className="block">{displayName(shift)}</span><span className="block text-[10px] font-normal">{intervalLabel(shift.startAt, shift.endAt)}</span><ShiftSourceRole shiftId={shift.id} position={shift.sourcePosition} locale={locale}/>{personControls?.(shift)}</th>
        {hours.map(hour => <td key={hour} data-testid={`q1-hour-cell-${shift.id}-${hour}`}>
          <div className={styles.hour}>
            {(zoom ? quarters : [null]).map(minute => {
              const cell: GridCell = { shiftId: shift.id, hour, minute }, code = refusal(cell);
              const pending = intents.filter(i => i.intent.shiftId === shift.id && Number(i.intent.quarter.slice(0, 2)) === hour && (minute === null || i.intent.granularity === "hour" || Number(i.intent.quarter.slice(3)) === minute));
              const start = +chicagoHourStart(day.date, hour) + (minute ?? 0) * 60_000, end = start + (minute === null ? 60 : 15) * 60_000;
              const hourSegments = savedHourSegments(day, shift.id, hour, !zoom) ?? [];
              const segments = hourSegments.flatMap(s => { const part = clipSegment(s, start, end); return part ? [part] : []; });
              const hourStart = +chicagoHourStart(day.date, hour);
              const content = <><SavedHour day={day} hour={hour} minute={minute ?? 0} minutes={minute === null ? 60 : 15} segments={segments} locale={locale} compactLabels splitHour={isSplitDisplayHour(hourSegments, hourStart, hourStart + 3_600_000)} />
                {pending.map(row => {
                  const intent = row.intent, offset = intent.granularity === "hour" ? 0 : Number(intent.quarter.slice(3));
                  const intentStart = hourStart + offset * 60_000, intentEnd = intentStart + (intent.granularity === "hour" ? 60 : 15) * 60_000;
                  const left = Math.max(start, intentStart, Date.parse(row.source.startAt)), right = Math.min(end, intentEnd, Date.parse(row.source.endAt));
                  if (left >= right) return null;
                  const station = intent.action === "station" ? day.stations.find(s => s.id === intent.stationId) : undefined;
                  const familyStation = intent.action === "family" ? day.stations.find(s => s.id === PAINT_FAMILIES[intent.family][0]) : undefined;
                  const label = station ? displayStationLabel(locale, station) : intent.action === "family" ? PAINT_FAMILY_LABELS[intent.family] : intent.action === "station" ? intent.stationId : es ? "Borrar" : "Erase";
                  const description = `${es ? "Privado" : "Private"}: ${label} · ${intervalLabel(new Date(left).toISOString(), new Date(right).toISOString())}`;
                  return <span key={row.intentId} className={`${styles.preview} ${station || familyStation ? stationColorClass((station ?? familyStation)!.color) : "bg-white text-neutral-950"}`} style={{ left: `${(left - start) / (end - start) * 100}%`, width: `${(right - left) / (end - start) * 100}%` }} data-testid="quarter-private-preview" title={description} aria-label={description}>
                    <span>{label}</span><span className="text-[9px]">{es ? "Privado" : "Private"}</span>
                  </span>;
                })}</>;

              return <div key={minute ?? "hour"} className={styles.cell} style={{ width: zoom ? "25%" : "100%" }}>
                {onPaint ? <button type="button" className={styles.paint} disabled={disabled || code === "SOURCE_NOT_AVAILABLE"}
                  id={cellId(cell)} data-testid={cellId(cell)} data-minute={minute ?? "hour"}
                  aria-describedby={notice?.shiftId === shift.id && notice.hour === hour && notice.minute === minute ? "q1-cell-notice-message" : undefined}
                  aria-label={`${displayName(shift)} ${formatHourLabel(hour)}${minute === null ? "" : ` · :${String(minute).padStart(2, "0")}`}`}
                  onPointerDown={event => { pointerInspection.current = event.currentTarget; suppressClick.current = false; if (event.pointerType === "mouse" && event.button === 0) drag.current = [cell]; }}
                  onPointerEnter={event => { if (event.pointerType === "mouse" && event.buttons === 1 && drag.current.length && !drag.current.some(c => c.shiftId === cell.shiftId && c.hour === hour && c.minute === minute)) drag.current.push(cell); }}
                  onPointerUp={() => { const cells = drag.current; drag.current = []; if (cells.length > 1) { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); void paint(cells); } }}
                  // Shrinking detail at pointer focus can clamp page scroll and move the
                  // button before release. Inspect on click; keyboard focus stays immediate.
                  onFocus={event => { if (pointerInspection.current !== event.currentTarget) setInspected(cell); }}
                  onClick={() => { pointerInspection.current = null; setInspected(cell); if (suppressClick.current) { suppressClick.current = false; return; } void paint([cell]); }}>{content}</button> : <button type="button" className={styles.paint} aria-label={`${displayName(shift)} · ${formatHourLabel(hour)}`} onClick={() => setInspected(cell)}>{content}</button>}

              </div>;
            })}
            {zoom && <span className={styles.guides} aria-hidden="true">{[25, 50, 75].map(left => <span key={left} style={{ left: `${left}%` }} />)}</span>}
          </div>
        </td>)}
      </tr>)}<SavedCoverRows day={day} locale={locale} hours={hours} quarterGuides={zoom} nameCellClassName={styles.person} interactiveDetails compactLabels /></tbody>
    </table>
  </div>
    {notice && <CellFeedback anchorId={cellId(notice)} testId="q1-cell-notice">
      <p>{quarterExplanation(notice.code, es)}</p>
      {notice.minute === null && ["HOUR_NEEDS_QUARTER", "HOUR_HAS_OBLIGATION", "QUARTER_DRAFT_REVIEW_ONLY"].includes(notice.code) && <button type="button" className="min-h-11 font-bold underline" onClick={() => openQuarters(notice.hour)}>{es ? "Dividir hora" : "Split hour"}</button>}
      <button type="button" className="ml-3 min-h-11 underline" onClick={() => onNotice?.(null)}>{es ? "Cerrar" : "Close"}</button>
    </CellFeedback>}
    {inspected && <div className="rounded border border-neutral-500 bg-white p-2 text-sm text-neutral-950" data-testid="q1-interval-detail" aria-live="polite">
      <strong>{day.shifts.find(s => s.id === inspected.shiftId)?.employee.firstName} · {formatHourLabel(inspected.hour)}</strong>
      {(savedHourSegments(day, inspected.shiftId, inspected.hour) ?? []).map((segment, index) => <p key={index}>{intervalLabel(segment.startAt, segment.endAt)} · {segment.kind === "break" ? "BREAK" : segment.kind === "cover" ? `${es ? "Cubre" : "Cover"} · ${segment.station?.label ?? "—"}` : segment.station?.label ?? (es ? "Sin pintar" : "Unpainted")}</p>)}
    </div>}
  </>;
}
