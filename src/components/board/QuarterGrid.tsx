"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chicagoHourStart, formatCompactHour, formatHourLabel, hourGridHours } from "@/lib/hour-grid";
import { scheduledIntervalHeadcounts } from "@/lib/board/headcounts";
import { hourEditRefusal, quarterEditRefusal } from "@/lib/quarter/client/edit";
import type { RetainedIntent } from "@/lib/quarter/client/draft-types";
import type { Locale } from "@/lib/i18n";
import { displayName } from "./board-helpers";
import { clipSegment, savedHourSegments } from "./cover-display";
import { SavedCoverRows, SavedHour, intervalLabel } from "./SavedCoverDisplay";
import type { DayBoardDto, ShiftDto } from "./types";
import styles from "./QuarterGrid.module.css";

export type GridCell = { shiftId: string; hour: number; minute: 0 | 15 | 30 | 45 | null };
export type GridNotice = GridCell & { code: string };
const hours = hourGridHours(), quarters = [0, 15, 30, 45] as const;
const nameWidth = 176, overviewWidth = 144;
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
    const cancel = () => { drag.current = []; };
    window.addEventListener("pointerup", cancel); window.addEventListener("pointercancel", cancel);
    return () => { window.removeEventListener("pointerup", cancel); window.removeEventListener("pointercancel", cancel); };
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
    for (const cell of cells) {
      const code = refusal(cell);
      if (code) { onNotice?.({ ...cell, code }); return; }
    }
    if (!hasChoice) return;
    select(cells.at(-1)!.hour); onNotice?.(null); await onPaint(cells);
  }
  function preview(rows: RetainedIntent[]) {
    return rows.map(({intent}) => `${intent.quarter} ${intent.action === "station" ? day.stations.find(s => s.id === intent.stationId)?.label ?? intent.stationId : intent.action === "family" ? intent.family : es ? "Borrar" : "Erase"}`).join(" · ");
  }
  return <><div ref={scroller} className={styles.scroller} data-testid="q1-grid-scroll" data-zoom={zoom ? "quarter" : "hour"}>
    <table className={styles.grid} style={{ width: nameWidth + hours.length * hourWidth }} data-testid="q1-grid">
      <colgroup><col style={{ width: nameWidth }} />{hours.map(h => <col key={h} style={{ width: hourWidth }} />)}</colgroup>
      <thead><tr>
        <th className={styles.person}><span>{es ? "Persona" : "Person"}</span><span className="block text-xs tabular-nums">{formatHourLabel(selectedHour)}</span></th>
        {hours.map(hour => <th key={hour} data-testid={`q1-hour-header-${hour}`}><button type="button" className="min-h-11 w-full font-bold" aria-pressed={selectedHour === hour} onClick={() => { centerRequested.current = zoom; select(hour); }}>{formatHourLabel(hour)}</button></th>)}
      </tr><tr data-testid="q1-headcount-row">
        <th className={styles.person}><span className="block text-xs">{es ? "Personal programado" : "Scheduled workers"}</span>
          <button type="button" data-testid="q1-zoom" className={`min-h-11 min-w-11 text-2xl font-black ${zoom ? "text-orange-700" : "text-blue-700"}`} aria-pressed={zoom} aria-label={es ? zoom ? "Ver horas completas" : "Ver cuartos de hora" : zoom ? "Show whole hours" : "Show quarter hours"} onClick={() => { centerRequested.current = true; setZoom(!zoom); onNotice?.(null); }}>{zoom ? "<#>" : ">#<"}</button>
        </th>
        {hours.map((hour, index) => <td key={hour}><div className="flex">{(zoom ? quarters : [0] as const).map((minute, q) => <span key={minute} className={styles.count} style={{ width: zoom ? "25%" : "100%" }} data-testid={`q1-count-${hour}-${minute}`}>
          <span className="block text-[10px]">{zoom ? `${formatCompactHour(hour)}:${String(minute).padStart(2, "0")}` : formatCompactHour(hour)}</span><strong>{counts[index * (zoom ? 4 : 1) + q]}</strong>
        </span>)}</div></td>)}
      </tr></thead>
      <tbody>{day.shifts.map(shift => <tr key={shift.id} data-testid={`q1-row-${shift.id}`}>
        <th className={styles.person} scope="row"><span className="block">{displayName(shift)}</span><span className="block text-[10px] font-normal">{intervalLabel(shift.startAt, shift.endAt)}</span>{personControls?.(shift)}</th>
        {hours.map(hour => <td key={hour} data-testid={`q1-hour-cell-${shift.id}-${hour}`}>
          <div className={styles.hour}>
            {(zoom ? quarters : [null]).map(minute => {
              const cell: GridCell = { shiftId: shift.id, hour, minute }, code = refusal(cell);
              const pending = intents.filter(i => i.intent.shiftId === shift.id && Number(i.intent.quarter.slice(0, 2)) === hour && (minute === null || i.intent.granularity === "hour" || Number(i.intent.quarter.slice(3)) === minute));
              const start = +chicagoHourStart(day.date, hour) + (minute ?? 0) * 60_000, end = start + (minute === null ? 60 : 15) * 60_000;
              const segments = (savedHourSegments(day, shift.id, hour) ?? []).flatMap(s => { const part = clipSegment(s, start, end); return part ? [part] : []; });
              const content = <><SavedHour day={day} hour={hour} minute={minute ?? 0} minutes={minute === null ? 60 : 15} segments={segments} locale={locale} />
                <span className={styles.preview} title={preview(pending)}>{pending.length > 0 && <span data-testid="quarter-private-preview">{es ? "Privado" : "Private"}: {preview(pending)}</span>}</span></>;
              return <div key={minute ?? "hour"} className={styles.cell} style={{ width: zoom ? "25%" : "100%" }}>
                {onPaint ? <button type="button" className={styles.paint} disabled={disabled || code === "SOURCE_NOT_AVAILABLE" || (!hasChoice && !code)}
                  data-testid={`quarter-cell-${shift.id}-${hour}${minute === null ? "" : `-${minute}`}`} data-minute={minute ?? "hour"}
                  aria-label={`${displayName(shift)} ${formatHourLabel(hour)}${minute === null ? "" : ` · :${String(minute).padStart(2, "0")}`}`}
                  onPointerDown={event => { suppressClick.current = false; if (event.pointerType === "mouse" && event.button === 0) drag.current = [cell]; }}
                  onPointerEnter={event => { if (event.pointerType === "mouse" && event.buttons === 1 && drag.current.length && !drag.current.some(c => c.shiftId === cell.shiftId && c.hour === hour && c.minute === minute)) drag.current.push(cell); }}
                  onPointerUp={() => { const cells = drag.current; drag.current = []; if (cells.length > 1) { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); void paint(cells); } }}
                  onFocus={() => setInspected(cell)}
                  onClick={() => { setInspected(cell); if (suppressClick.current) { suppressClick.current = false; return; } void paint([cell]); }}>{content}</button> : <button type="button" className={styles.paint} aria-label={`${displayName(shift)} · ${formatHourLabel(hour)}`} onClick={() => setInspected(cell)}>{content}</button>}
                {notice?.shiftId === shift.id && notice.hour === hour && notice.minute === minute && <div className={styles.notice} role="alert" data-testid="q1-cell-notice">
                  <p>{quarterExplanation(notice.code, es)}</p>
                  {minute === null && ["HOUR_NEEDS_QUARTER", "HOUR_HAS_OBLIGATION", "QUARTER_DRAFT_REVIEW_ONLY"].includes(notice.code) && <button type="button" className="min-h-11 font-bold underline" onClick={() => openQuarters(hour)}>{es ? "Editar cuartos" : "Edit quarters"}</button>}
                  <button type="button" className="ml-3 min-h-11 underline" onClick={() => onNotice?.(null)}>{es ? "Cerrar" : "Close"}</button>
                </div>}
              </div>;
            })}
            {zoom && <span className={styles.guides} aria-hidden="true">{[25, 50, 75].map(left => <span key={left} style={{ left: `${left}%` }} />)}</span>}
          </div>
        </td>)}
      </tr>)}<SavedCoverRows day={day} locale={locale} hours={hours} quarterGuides={zoom} /></tbody>
    </table>
  </div>
    {inspected && <div className="rounded border border-neutral-500 bg-white p-2 text-sm text-neutral-950" data-testid="q1-interval-detail" aria-live="polite">
      <strong>{day.shifts.find(s => s.id === inspected.shiftId)?.employee.firstName} · {formatHourLabel(inspected.hour)}</strong>
      {(savedHourSegments(day, inspected.shiftId, inspected.hour) ?? []).map((segment, index) => <p key={index}>{intervalLabel(segment.startAt, segment.endAt)} · {segment.kind === "break" ? "BREAK" : segment.kind === "cover" ? `${es ? "Cubre" : "Cover"} · ${segment.station?.label ?? "—"}` : segment.station?.label ?? (es ? "Sin pintar" : "Unpainted")}</p>)}
    </div>}
  </>;
}
