"use client";

import { useMemo, useState } from "react";
import { formatCompactHour, formatHourLabel, hourGridHours, chicagoHourStart } from "@/lib/hour-grid";
import { isFutureHour } from "@/lib/rules/live-hour";
import { MOVE_REASONS, type MoveReason } from "@/lib/position-moves";
import { displayStationLabel, moveReasonLabel, type Locale, type Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import type { PaintEdit } from "@/lib/assignments/paint";
import { readPaintDraft, writePaintDraft } from "@/lib/board/paint-drafts";
import { isHourInShift } from "@/lib/rules/shift-window";
import { abilityFor, assignmentsAtStationHour, displayName, stationColorClass } from "./board-helpers";
import { buildTimelineRows, personName } from "./timeline-rows";
import type { BoardKindUi, DayBoardDto, ShiftDto } from "./types";

type Props = {
  day: DayBoardDto | null;
  board: BoardKindUi;
  date: string;
  locale: Locale;
  t: Messages;
  selectedHour: number;
  onSelectHour: (hour: number) => void;
  managerToken: string;
  managerId: string;
  readonly: boolean;
  onSaved: () => Promise<void>;
  onDraftChange: () => void;
};

type Draft = Record<string, PaintEdit>;
type PendingReason = { edit: PaintEdit; name: string; from: string };

function draftKey(shiftId: string, hour: number): string {
  return `${shiftId}|${hour}`;
}

function shiftTime(value: string, locale: Locale): string {
  return new Date(value).toLocaleTimeString(locale === "es" ? "es-MX" : "en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });
}

function currentAssignment(shift: ShiftDto, date: string, hour: number) {
  const start = chicagoHourStart(date, hour).getTime();
  return shift.assignments.find((a) => new Date(a.hourStart).getTime() === start) ?? null;
}

function editStillMatches(day: DayBoardDto, date: string, edit: PaintEdit): boolean {
  const shift = day.shifts.find((candidate) => candidate.id === edit.shiftId);
  if (!shift || shift.supersededAt || shift.date !== date || shift.board !== day.board) return false;
  if (shift.startAt !== edit.expectedShift.startAt || shift.endAt !== edit.expectedShift.endAt ||
      shift.employee.id !== edit.expectedShift.employeeId ||
      shift.sourcePosition !== edit.expectedShift.sourcePosition) return false;
  const hourStart = chicagoHourStart(date, edit.hour);
  if (!isHourInShift(hourStart, new Date(shift.startAt), new Date(shift.endAt))) return false;
  const current = currentAssignment(shift, date, edit.hour);
  if (current?.id !== (edit.expected?.id ?? undefined) ||
      current?.stationId !== (edit.expected?.stationId ?? undefined)) return false;
  return edit.stationId == null || (
    day.stations.some((station) => station.id === edit.stationId) &&
    abilityFor(shift, edit.stationId) !== "forbidden"
  );
}

/** Manager's combined position palette, current-hour board and timeline. */
export function ManagerColorEditor({
  day, board, date, locale, t, selectedHour, onSelectHour,
  managerToken, managerId, readonly, onSaved, onDraftChange,
}: Props) {
  const hours = useMemo(() => hourGridHours(), []);
  const [selected, setSelected] = useState<string | "erase" | null>(null);
  const [draftState, setDraftState] = useState<{ draft: Draft; undo: Draft[] }>(() => {
    const saved = readPaintDraft(managerId, board, date);
    return {
      draft: Object.fromEntries((saved?.edits ?? []).map((edit) => [draftKey(edit.shiftId, edit.hour), edit])),
      undo: [],
    };
  });
  const [restored, setRestored] = useState(() => Boolean(readPaintDraft(managerId, board, date)?.edits.length));
  const [storageError, setStorageError] = useState<"retain" | "clear" | null>(null);
  const [pendingReason, setPendingReason] = useState<(PendingReason & { snapshot: string }) | null>(null);
  const [reason, setReason] = useState<MoveReason>("Other");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const copy = locale === "es" ? {
    title: "Pintar posiciones",
    palette: "Puestos y colores",
    erase: "Borrar",
    pick: "Elige un puesto o Borrar, luego toca una hora.",
    selected: "Seleccionado",
    pending: (n: number) => `${n} cambio${n === 1 ? "" : "s"} pendiente${n === 1 ? "" : "s"}; el personal ve solo lo guardado.`,
    saved: "Guardado. El personal puede ver los cambios.",
    saving: "Guardando…",
    save: "Guardar cambios",
    undo: "Deshacer",
    discard: "Descartar",
    conflict: "El tablero cambió. Revisa las horas marcadas; no se pueden guardar todavía.",
    failed: "No se pudieron guardar los cambios.",
    refreshed: "El tablero cambió. Guardamos tu borrador en este dispositivo; revisa las horas marcadas antes de Guardar.",
    restored: "Borrador recuperado en este dispositivo. Revisa los cambios antes de Guardar.",
    storageError: "Este dispositivo no pudo conservar el borrador. Guárdalo antes de salir.",
    storageClearError: "Este dispositivo no pudo borrar el borrador local; puede reaparecer aunque ya lo hayas guardado o descartado.",
    removeStale: "Quitar del borrador",
    forbidden: "Esta persona no puede trabajar en ese puesto.",
    needChoice: "Elige un puesto o Borrar primero.",
    reasonTitle: "Motivo para cambiar un puesto actual o pasado",
    noPerson: "Sin persona",
  } : {
    title: "Color positions",
    palette: "Positions and colors",
    erase: "Erase",
    pick: "Pick a position or Erase, then tap one hour.",
    selected: "Selected",
    pending: (n: number) => `${n} pending change${n === 1 ? "" : "s"}; staff see saved assignments only.`,
    saved: "Saved. Staff can see the changes.",
    saving: "Saving…",
    save: "Save changes",
    undo: "Undo",
    discard: "Discard",
    conflict: "The board changed. Review the painted hours; saving is blocked for now.",
    failed: "Could not save the changes.",
    refreshed: "The board changed. Your draft is kept on this device; review the marked hours before saving.",
    restored: "Draft recovered on this device. Review it before saving.",
    storageError: "This device could not keep the draft. Save it before leaving.",
    storageClearError: "This device could not clear the local draft; it may reappear even after saving or discarding.",
    removeStale: "Remove from draft",
    forbidden: "This person cannot work that position.",
    needChoice: "Pick a position or Erase first.",
    reasonTitle: "Reason for changing a current or past position",
    noPerson: "No person",
  };

  // The editor mounts only after manager unlock. Its keyed mount re-reads that
  // manager's local draft; staff and other managers never mount these cells.
  const snapshot = useMemo(() => JSON.stringify(day?.shifts.map((sh) => [
    sh.id, sh.startAt, sh.endAt, sh.sourcePosition, sh.employee.id, sh.supersededAt,
    sh.assignments.map((a) => [a.id, a.stationId, a.hourStart]).sort(),
  ]).sort() ?? []), [day]);
  const pendingCount = Object.keys(draftState.draft).length;
  const staleDraft = day != null && Object.values(draftState.draft).some((edit) => !editStillMatches(day, date, edit));
  const draft = staleDraft ? {} : draftState.draft;
  const undo = draftState.undo;
  const activePendingReason = pendingReason?.snapshot === snapshot ? pendingReason : null;

  const rows = useMemo(() => day ? buildTimelineRows({
    shifts: day.shifts,
    date,
    hours,
    offLabel: t.timelineOffShift,
    unassignedLabel: t.timelineUnassigned,
    stationLabelFor: (id) => displayStationLabel(locale, day.stations.find((s) => s.id === id) ?? { id, label: id, color: "gray", maxConcurrent: 1, sortOrder: 0, priority: null }),
  }) : [], [day, date, hours, locale, t]);

  function commitDraft(next: Draft, nextUndo: Draft[]) {
    const retained = writePaintDraft(managerId, board, date, Object.values(next));
    setStorageError(retained ? null : Object.keys(next).length > 0 ? "retain" : "clear");
    setDraftState({ draft: next, undo: nextUndo });
    onDraftChange();
  }

  async function submit(edits: PaintEdit[]) {
    if (busy || readonly || !day || staleDraft || edits.length === 0) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/assignments/paint", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify({ board, date, edits }),
      });
      const body = await response.json() as { error?: string; code?: string };
      if (!response.ok) {
        setFeedback({ kind: "err", text: body.error ?? copy.failed });
        if (response.status === 409 || response.status === 401) await onSaved();
        return;
      }
      commitDraft({}, []);
      setRestored(false);
      setFeedback({ kind: "ok", text: copy.saved });
      await onSaved();
    } catch {
      setFeedback({ kind: "err", text: copy.failed });
    } finally {
      setBusy(false);
    }
  }

  function stage(edit: PaintEdit) {
    const k = draftKey(edit.shiftId, edit.hour);
    const next = { ...draftState.draft };
    if (edit.stationId === edit.expected?.stationId || (edit.stationId == null && edit.expected == null)) {
      delete next[k];
    } else {
      next[k] = edit;
    }
    commitDraft(next, [...undo, draftState.draft]);
    setFeedback(null);
  }

  function paint(shift: ShiftDto, hour: number, off: boolean) {
    if (busy || readonly || off || shift.supersededAt) return;
    if (selected == null) {
      setFeedback({ kind: "err", text: copy.needChoice });
      return;
    }
    const stationId = selected === "erase" ? null : selected;
    if (stationId && abilityFor(shift, stationId) === "forbidden") {
      setFeedback({ kind: "err", text: copy.forbidden });
      return;
    }
    const assignment = currentAssignment(shift, date, hour);
    const edit: PaintEdit = {
      shiftId: shift.id,
      hour,
      expectedShift: { startAt: shift.startAt, endAt: shift.endAt, employeeId: shift.employee.id, sourcePosition: shift.sourcePosition },
      expected: assignment ? { id: assignment.id, stationId: assignment.stationId } : null,
      stationId,
    };
    if (assignment && stationId !== assignment.stationId && !isFutureHour(chicagoHourStart(date, hour), new Date())) {
      setPendingReason({ snapshot, edit, name: personName(shift), from: assignment.stationId });
      return;
    }
    stage(edit);
  }

  const selectedStation = day?.stations.find((station) => station.id === selected);

  return (
    <section className="min-w-0 rounded-lg border-2 border-neutral-900 bg-white p-3" data-testid="manager-color-editor">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{copy.title}</h2>
          <p className="text-sm text-neutral-700">{copy.pick}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold" role="status" data-testid="paint-pending">{copy.pending(pendingCount)}</span>
          <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-700 px-3 text-sm font-bold disabled:opacity-50" onClick={() => {
            const previous = undo.at(-1);
            if (!previous) return;
            commitDraft(previous, undo.slice(0, -1));
          }} disabled={busy || undo.length === 0} data-testid="paint-undo">{copy.undo}</button>
          <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-700 px-3 text-sm font-bold disabled:opacity-50" onClick={() => { commitDraft({}, []); setRestored(false); }} disabled={busy || pendingCount === 0} data-testid="paint-discard">{copy.discard}</button>
          <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 bg-neutral-900 px-3 text-sm font-bold text-white disabled:opacity-50" onClick={() => void submit(Object.values(draftState.draft))} disabled={busy || readonly || !day || staleDraft || pendingCount === 0} data-testid="paint-save">{busy ? copy.saving : copy.save}</button>
        </div>
      </div>
      {(feedback || staleDraft) && <p className={cn("mb-3 rounded-md border-2 px-3 py-2 text-sm font-bold", !staleDraft && feedback?.kind === "ok" ? "border-emerald-800 bg-emerald-50 text-emerald-950" : "border-red-800 bg-red-50 text-red-950")} role={staleDraft || feedback?.kind === "err" ? "alert" : "status"} data-testid="paint-feedback">{staleDraft ? storageError === "retain" ? copy.conflict : copy.refreshed : feedback?.text}</p>}
      {restored && pendingCount > 0 && !staleDraft && <p className="mb-3 rounded-md border-2 border-blue-800 bg-blue-50 px-3 py-2 text-sm font-bold text-blue-950" role="status" data-testid="paint-restored">{copy.restored}</p>}
      {storageError && <p className="mb-3 rounded-md border-2 border-red-800 bg-red-50 px-3 py-2 text-sm font-bold text-red-950" role="alert" data-testid="paint-storage-error">{storageError === "retain" ? copy.storageError : copy.storageClearError}</p>}
      {staleDraft && <ul className="mb-3 space-y-1" data-testid="paint-stale-list">{Object.values(draftState.draft).filter((edit) => day && !editStillMatches(day, date, edit)).map((edit) => {
        const shift = day?.shifts.find((candidate) => candidate.id === edit.shiftId);
        const target = day?.stations.find((station) => station.id === edit.stationId);
        return <li key={draftKey(edit.shiftId, edit.hour)} className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-800 px-2 py-1 text-sm">
          <span>{shift ? personName(shift) : edit.expectedShift.sourcePosition} · {formatHourLabel(edit.hour)} · {target ? displayStationLabel(locale, target) : edit.stationId ?? copy.erase}</span>
          <button type="button" className="touch-target min-h-11 rounded border border-red-800 px-2 font-bold" onClick={() => {
            const next = { ...draftState.draft };
            delete next[draftKey(edit.shiftId, edit.hour)];
            commitDraft(next, [...undo, draftState.draft]);
          }}>{copy.removeStale}</button>
        </li>;
      })}</ul>}
      <div className="grid min-w-0 gap-3 md:grid-cols-[11rem_minmax(0,1fr)]">
        <aside className="min-w-0" aria-label={copy.palette}>
          <h3 className="mb-2 text-sm font-bold">{copy.palette}</h3>
          <div className="flex gap-2 overflow-x-auto pb-1 md:max-h-[65vh] md:flex-col md:overflow-y-auto" data-testid="paint-palette">
            {(day?.stations ?? []).map((station) => {
              const people = day ? assignmentsAtStationHour(day.shifts, station.id, date, selectedHour).map(({ shift }) => displayName(shift)) : [];
              return <button key={station.id} type="button" className={cn("touch-target min-h-11 rounded-md border-2 px-2 py-2 text-left text-sm font-bold md:w-full", stationColorClass(station.color), selected === station.id && "ring-2 ring-neutral-900 ring-offset-2")} style={{ minWidth: "8.5rem", flexShrink: 0 }} aria-pressed={selected === station.id} onClick={() => setSelected(station.id)} data-testid={`paint-palette-${station.id}`}>
                <span className="block">{displayStationLabel(locale, station)}</span>
                <span className="block text-xs font-medium">{formatCompactHour(selectedHour)} · {people.join(", ") || copy.noPerson}</span>
              </button>;
            })}
            <button type="button" className={cn("touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-2 text-left text-sm font-bold md:w-full", selected === "erase" && "ring-2 ring-neutral-900 ring-offset-2")} style={{ minWidth: "8.5rem", flexShrink: 0 }} aria-pressed={selected === "erase"} onClick={() => setSelected("erase")} data-testid="paint-palette-erase">{copy.erase}</button>
          </div>
          <p className="mt-2 text-xs font-semibold" data-testid="paint-selected">{copy.selected}: {selectedStation ? displayStationLabel(locale, selectedStation) : selected === "erase" ? copy.erase : "—"}</p>
        </aside>
        <div className="min-w-0 overflow-x-auto" data-testid="paint-matrix">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead><tr>
              <th className="sticky left-0 z-20 min-w-[10rem] border-b-2 border-r-2 border-neutral-900 bg-white px-2 py-1 text-sm font-bold" scope="col">{t.person}</th>
              {hours.map((hour) => <th key={hour} className={cn("min-w-[5rem] border-b-2 border-neutral-900 px-1 text-center", selectedHour === hour && "bg-neutral-900 text-white")} scope="col"><button type="button" className="touch-target min-h-11 w-full font-bold" onClick={() => onSelectHour(hour)} aria-label={formatHourLabel(hour)}>{formatCompactHour(hour)}</button></th>)}
            </tr></thead>
            <tbody>{rows.map(({ shift, cells, ended, laterShiftOfPerson }) => <tr key={shift.id} data-testid={`paint-row-${shift.id}`}>
              <th className="sticky left-0 z-10 border-b border-r-2 border-neutral-300 bg-white px-2 py-1.5 text-sm font-bold" scope="row">
                <span className="block">{personName(shift)} {ended ? `· ${t.shiftEnded}` : ""}</span>
                <span className="block text-[11px] font-medium text-neutral-600">{laterShiftOfPerson ? "↳ " : ""}{shiftTime(shift.startAt, locale)}–{shiftTime(shift.endAt, locale)}</span>
              </th>
              {cells.map((cell, index) => {
                const hour = hours[index]!;
                const edit = draft[draftKey(shift.id, hour)];
                const stationId = edit ? edit.stationId : cell.stationId;
                const station = day?.stations.find((s) => s.id === stationId);
                const label = station ? displayStationLabel(locale, station) : cell.kind === "off" ? t.timelineOffShift : t.timelineUnassigned;
                return <td key={hour} className="border-b border-neutral-300 p-0.5 text-center" data-kind={cell.kind} data-pending={edit ? "1" : "0"}>
                  {cell.kind === "off" || ended ? <span className="block min-h-11 content-center text-neutral-500">{label}</span> : <button type="button" className={cn("touch-target min-h-11 w-full rounded border-2 px-1 text-xs font-bold leading-tight", station ? stationColorClass(station.color) : "border-dashed border-neutral-400 bg-white text-neutral-700", edit && "ring-2 ring-inset ring-amber-700", readonly && "opacity-60")} disabled={readonly || busy} onClick={() => paint(shift, hour, false)} aria-label={`${personName(shift)}, ${formatHourLabel(hour)}, ${label}${edit ? `, ${copy.pending(1)}` : ""}`} data-testid={`paint-cell-${shift.id}-${hour}`}>{label}{edit && <span className="block text-[10px] uppercase">{locale === "es" ? "Pendiente" : "Pending"}</span>}</button>}
                </td>;
              })}
            </tr>)}</tbody>
          </table>
          {rows.length === 0 && <p className="p-4 text-sm font-semibold text-neutral-600">{t.timelineEmpty}</p>}
        </div>
      </div>
      {activePendingReason && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="paint-reason-title" data-testid="paint-reason-dialog">
        <div className="w-full max-w-md rounded-lg border-2 border-neutral-900 bg-white p-4">
          <h3 id="paint-reason-title" className="text-lg font-bold">{copy.reasonTitle}</h3>
          <p className="mt-1 text-sm">{activePendingReason.name} · {formatHourLabel(activePendingReason.edit.hour)}</p>
          <label className="mt-3 block text-sm font-bold">{t.reason}
            <select className="touch-target mt-1 min-h-11 w-full rounded-md border-2 border-neutral-900 px-2" value={reason} onChange={(e) => setReason(e.target.value as MoveReason)}>{MOVE_REASONS.map((r) => <option key={r} value={r}>{moveReasonLabel(locale, r)}</option>)}</select>
          </label>
          <label className="mt-3 block text-sm font-bold">{t.noteOptional}
            <input className="touch-target mt-1 min-h-11 w-full rounded-md border-2 border-neutral-900 px-2" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 font-bold" onClick={() => setPendingReason(null)}>{t.cancel}</button>
            <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 bg-neutral-900 px-3 font-bold text-white" onClick={() => {
              stage({ ...activePendingReason.edit, reason, note });
              setPendingReason(null);
              setNote("");
            }}>{t.save}</button>
          </div>
        </div>
      </div>}
    </section>
  );
}
