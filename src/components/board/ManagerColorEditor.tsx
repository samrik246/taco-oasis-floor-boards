"use client";

import { useMemo, useState } from "react";
import { formatCompactHour, formatHourLabel, hourGridHours, chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { breakStripeLabel } from "@/lib/breaks/stripe-label";
import { BreakStripe } from "@/components/breaks/BreakStripe";
import { isFutureHour } from "@/lib/rules/live-hour";
import { MOVE_REASONS, type MoveReason } from "@/lib/position-moves";
import { boardStationLabel, displayStationLabel, moveReasonLabel, type Locale, type Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import type { PaintEdit } from "@/lib/assignments/paint";
import { PAINT_FAMILIES, PAINT_FAMILY_LABELS, isPaintFamily, type PaintFamily } from "@/lib/assignments/paint-families";
import { paletteStationIds } from "@/lib/assignments/palette-order";
import { readPaintDraft, writePaintDraft } from "@/lib/board/paint-drafts";
import { isHourInShift } from "@/lib/rules/shift-window";
import { eligibilityCellKind, eligibilityDots, isDefaultMandatory, mandatoryGapLabel, uncoveredMandatory, type EligibilityDot } from "@/lib/mandatory";
import { markForStation, openCellOutlineClass, selectionMark } from "@/lib/selection-mark";
import { comparePintarRows, stationAtSelectedHour, type ScheduleSort } from "@/lib/schedule/build-schedule";
import { stationSolidClass } from "@/lib/schedule/station-codes";
import { abilityFor, assignmentsAtStationHour, displayName, stationColorClass } from "./board-helpers";
import { SelectionMarkDot } from "./SelectionMarkDot";
import { buildTimelineRows, personName } from "./timeline-rows";
import type { BoardKindUi, DayBoardDto, ShiftDto, StationDto } from "./types";

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
  showLevels: boolean;
  onSaved: () => Promise<void>;
  onDraftChange: () => void;
};

type Draft = Record<string, PaintEdit>;
type PendingReason = { edit: PaintEdit; name: string; from: string };
type PaletteChoice = { id: string; stationIds: readonly string[]; label: string; color: string | null };

function familyChoice(id: string): PaintFamily | null {
  const name = id.startsWith("family:") ? id.slice(7) : null;
  return isPaintFamily(name) ? name : null;
}

function paletteChoices(day: DayBoardDto | null): PaletteChoice[] {
  if (!day) return [];
  const byId = new Map(day.stations.map((station) => [station.id, station]));
  // Saved stationUse only. A paint draft is not an input, so the buttons stay put.
  return paletteStationIds({
    stations: day.stations,
    stationUse: day.stationUse,
    extraStationIds: day.mandatory?.extraStationIds,
  }).flatMap((id): PaletteChoice[] => {
    const station = byId.get(id);
    if (!station) return [];
    return [{ id: station.id, stationIds: [station.id], label: station.label, color: station.color }];
  });
}

function EligibilityDots({
  shiftId,
  hour,
  dots,
  stations,
}: {
  shiftId: string;
  hour: number;
  dots: readonly EligibilityDot[];
  stations: readonly StationDto[];
}) {
  return <span className="mt-0.5 flex flex-wrap items-center justify-center gap-x-px gap-y-0.5" data-testid={`eligibility-dots-${shiftId}-${hour}`} aria-hidden="true">{dots.map((dot) => {
    const station = stations.find((item) => item.id === dot.stationId);
    const mark = selectionMark(dot.level);
    if (!station || mark === "none") return null;
    return <SelectionMarkDot key={dot.stationId} color={station.color} mark={mark} level={dot.level} testId={`eligibility-dot-${shiftId}-${hour}-${dot.stationId}`} />;
  })}</span>;
}

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
  if (edit.family) return PAINT_FAMILIES[edit.family].every((id) =>
    day.stations.some((station) => station.id === id)) &&
    PAINT_FAMILIES[edit.family].some((id) => abilityFor(shift, id) !== "forbidden");
  return edit.stationId == null || (
    day.stations.some((station) => station.id === edit.stationId) &&
    abilityFor(shift, edit.stationId) !== "forbidden"
  );
}

/** Manager's combined position palette, current-hour board and timeline. */
export function ManagerColorEditor({
  day, board, date, locale, t, selectedHour, onSelectHour,
  managerToken, managerId, readonly, showLevels, onSaved, onDraftChange,
}: Props) {
  const hours = useMemo(() => hourGridHours(), []);
  const [selected, setSelected] = useState<string | "erase" | null>(null);
  const [rowSort, setRowSort] = useState<ScheduleSort>("time");
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
    pick: "Elige un puesto o Borrar; luego toca una hora.",
    auto: "Auto",
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
    full: "Todos los números están ocupados en esa hora. Nadie fue reemplazado.",
    taken: (seat: string, hour: string) => `${seat} ya está ocupado a las ${hour}.`,
    sortLabel: "Orden de filas",
    sortClock: "Entrada",
    sortName: "Nombre",
    sortPosition: "Puesto",
    needChoice: "Elige un puesto o Borrar primero.",
    markFailed: "No se pudo marcar el puesto.",
    reasonTitle: "Motivo para cambiar un puesto actual o pasado",
    noPerson: "Sin persona",
  } : {
    title: "Color positions",
    palette: "Positions and colors",
    erase: "Erase",
    pick: "Pick a position or Erase, then tap an hour.",
    auto: "Auto",
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
    full: "All numbered positions are occupied at that hour. Nobody was replaced.",
    taken: (seat: string, hour: string) => `${seat} is already taken at ${hour}.`,
    sortLabel: "Row order",
    sortClock: "Clock-in",
    sortName: "Name",
    sortPosition: "Position",
    needChoice: "Pick a position or Erase first.",
    markFailed: "Could not mark the position.",
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

  const rows = useMemo(() => {
    if (!day) return [];
    const built = buildTimelineRows({
      shifts: day.shifts,
      date,
      hours,
      offLabel: t.timelineOffShift,
      unassignedLabel: t.timelineUnassigned,
      stationLabelFor: (id) => displayStationLabel(locale, day.stations.find((s) => s.id === id) ?? { id, label: id, color: "gray", maxConcurrent: 1, sortOrder: 0, priority: null }),
    });
    const stationOrder = new Map(day.stations.map((station) => [station.id, station.sortOrder]));
    return [...built].sort((a, b) => {
      const pendingFor = (shift: ShiftDto) => {
        const edit = draft[draftKey(shift.id, selectedHour)];
        if (!edit) return null;
        const current = currentAssignment(shift, date, selectedHour)?.stationId ?? null;
        if (edit.family && current && (PAINT_FAMILIES[edit.family] as readonly string[]).includes(current)) {
          return { stationId: current };
        }
        return { stationId: edit.stationId };
      };
      return comparePintarRows(
        {
          name: personName(a.shift),
          employeeId: a.shift.employee.id,
          startAt: a.shift.startAt,
          shiftId: a.shift.id,
          stationId: stationAtSelectedHour(a.shift.assignments, date, selectedHour, pendingFor(a.shift)),
        },
        {
          name: personName(b.shift),
          employeeId: b.shift.employee.id,
          startAt: b.shift.startAt,
          shiftId: b.shift.id,
          stationId: stationAtSelectedHour(b.shift.assignments, date, selectedHour, pendingFor(b.shift)),
        },
        rowSort,
        stationOrder,
      );
    });
  }, [day, date, hours, locale, t, draft, selectedHour, rowSort]);
  const choices = useMemo(() => paletteChoices(day), [day]);
  const gaps = useMemo(() => {
    if (!day?.mandatory) return [];
    return uncoveredMandatory({
      stationIds: day.mandatory.stationIds,
      boardOrder: day.stations.map((station) => station.id),
      hours,
      date,
      shifts: day.shifts,
      drafts: Object.values(draft).map((edit) => ({
        shiftId: edit.shiftId,
        hour: edit.hour,
        stationId: edit.stationId,
      })),
    });
  }, [day, hours, date, draft]);

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
    if (!edit.family && (edit.stationId === edit.expected?.stationId ||
        (edit.stationId == null && edit.expected == null))) {
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
    const family = familyChoice(selected);
    const stationId = selected === "erase" || family ? null : selected;
    if ((family && PAINT_FAMILIES[family].every((id) => abilityFor(shift, id) === "forbidden")) ||
        (stationId && abilityFor(shift, stationId) === "forbidden")) {
      setFeedback({ kind: "err", text: copy.forbidden });
      return;
    }
    const assignment = currentAssignment(shift, date, hour);
    if (stationId && day) {
      const hourStartMs = chicagoHourStart(date, hour).getTime();
      const movingOut = new Set(
        Object.values(draftState.draft)
          .filter((pending) => {
            if (pending.hour !== hour || pending.expected?.stationId !== stationId) return false;
            if (pending.family && (PAINT_FAMILIES[pending.family] as readonly string[]).includes(stationId)) return false;
            return pending.stationId !== stationId;
          })
          .map((pending) => pending.expected!.id),
      );
      const savedTaken = day.shifts.some((person) => person.assignments.some((cell) =>
        cell.stationId === stationId &&
        new Date(cell.hourStart).getTime() === hourStartMs &&
        cell.id !== assignment?.id &&
        !movingOut.has(cell.id),
      ));
      const pendingIn = Object.values(draftState.draft).some((pending) =>
        pending.hour === hour && pending.stationId === stationId && pending.shiftId !== shift.id,
      );
      if (savedTaken || pendingIn) {
        const station = day.stations.find((candidate) => candidate.id === stationId);
        const seat = station ? displayStationLabel(locale, station) : stationId;
        setFeedback({ kind: "err", text: copy.taken(seat, formatHourLabel(hour)) });
        return;
      }
    }
    const validCurrentFamily = family && assignment &&
      (PAINT_FAMILIES[family] as readonly string[]).includes(assignment.stationId) &&
      abilityFor(shift, assignment.stationId) !== "forbidden";
    if (family && day && !validCurrentFamily) {
      const currentTime = chicagoHourStart(date, hour).getTime();
      const occupied = day.shifts.flatMap((person) => person.assignments).filter((cell) =>
        new Date(cell.hourStart).getTime() === currentTime &&
        !Object.values(draftState.draft).some((pending) => pending.expected?.id === cell.id));
      const free = PAINT_FAMILIES[family].some((id) => {
        const station = day.stations.find((candidate) => candidate.id === id);
        return station && abilityFor(shift, id) !== "forbidden" &&
          occupied.filter((cell) => cell.stationId === id).length +
          Object.values(draftState.draft).filter((pending) => pending.hour === hour && pending.stationId === id).length < station.maxConcurrent;
      });
      if (!free) {
        setFeedback({ kind: "err", text: copy.full });
        return;
      }
    }
    const edit: PaintEdit = {
      shiftId: shift.id,
      hour,
      expectedShift: { startAt: shift.startAt, endAt: shift.endAt, employeeId: shift.employee.id, sourcePosition: shift.sourcePosition },
      expected: assignment ? { id: assignment.id, stationId: assignment.stationId } : null,
      stationId,
      ...(family ? { family } : {}),
    };
    if (assignment && !validCurrentFamily && stationId !== assignment.stationId &&
        !isFutureHour(chicagoHourStart(date, hour), new Date())) {
      setPendingReason({ snapshot, edit, name: personName(shift), from: assignment.stationId });
      return;
    }
    stage(edit);
  }

  async function toggleMandatory(stationId: string, on: boolean) {
    if (busy || readonly || day?.mandatory?.canMark !== true) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/mandatory", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify({ date, stationId, on }),
      });
      if (!response.ok) {
        setFeedback({ kind: "err", text: copy.markFailed });
        return;
      }
      await onSaved();
    } catch {
      setFeedback({ kind: "err", text: copy.markFailed });
    } finally {
      setBusy(false);
    }
  }

  const selectedChoice = choices.find((choice) => choice.id === selected);
  const paletteStation = selected && selected !== "erase"
    ? day?.stations.find((item) => item.id === selected) ?? null
    : null;

  return (
    <section className="min-w-0 rounded-lg border-2 border-neutral-900 bg-white p-3" data-testid="manager-color-editor">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{copy.title}</h2>
          <p className="text-sm text-neutral-700">{copy.pick}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold" role="status" data-testid="paint-pending">{copy.pending(pendingCount)}</span>
          <button type="button" className={cn("touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-3 text-sm font-bold", selected === "erase" && "ring-2 ring-neutral-900 ring-offset-2")} aria-pressed={selected === "erase"} onClick={() => setSelected("erase")} data-testid="paint-palette-erase">{copy.erase}</button>
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
          <span>{shift ? personName(shift) : edit.expectedShift.sourcePosition} · {formatHourLabel(edit.hour)} · {edit.family ? PAINT_FAMILY_LABELS[edit.family] : target ? displayStationLabel(locale, target) : edit.stationId ? boardStationLabel(locale, edit.stationId, day?.stations ?? []) : copy.erase}</span>
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
            {choices.map((choice) => {
              const people = day ? choice.stationIds.flatMap((id) => assignmentsAtStationHour(day.shifts, id, date, selectedHour).map(({ shift }) => displayName(shift))) : [];
              const stationId = choice.id;
              const station = day?.stations.find((item) => item.id === stationId);
              const missing = gaps.some((gap) => gap.stationId === stationId && gap.hour === selectedHour);
              const marked = day?.mandatory?.extraStationIds.includes(stationId) ?? false;
              const canToggle = day?.mandatory?.canMark === true && !isDefaultMandatory(stationId);
              return <div key={choice.id} className="relative w-48 shrink-0 md:w-full">
                <button type="button" className={cn("touch-target min-h-11 w-full rounded-md border-2 px-2 py-2 text-left text-sm font-bold", canToggle && "pb-7", choice.color ? (missing ? stationSolidClass(choice.color) : stationColorClass(choice.color)) : "border-neutral-800 bg-neutral-100 text-neutral-950", missing && "ring-4 ring-neutral-950", !missing && selected === choice.id && "ring-2 ring-neutral-900 ring-offset-2")} aria-pressed={selected === choice.id} onClick={() => setSelected(choice.id)} data-testid={`paint-palette-${choice.id}`} data-falta={missing ? "1" : "0"}>
                  <span className="block">{station ? displayStationLabel(locale, station) : choice.label}</span>
                  <span className="block text-xs font-medium">{formatCompactHour(selectedHour)} · {people.join(", ") || copy.noPerson}</span>
                  {missing && <span className="block text-xs font-bold uppercase">Falta</span>}
                </button>
                {canToggle && <button type="button" className="touch-target absolute bottom-1 left-1 z-10 flex items-end justify-start border-0 bg-transparent p-0" aria-pressed={marked} disabled={busy || readonly} onClick={() => void toggleMandatory(stationId, !marked)} data-testid={`mandatory-toggle-${stationId}`}><span data-mandatory-face className={cn("pointer-events-none self-end whitespace-nowrap rounded-full border border-neutral-900 px-2 py-0.5 text-[11px] font-bold leading-tight", marked ? "bg-neutral-900 text-white" : "bg-white text-neutral-950")}>Obligatorio hoy</span></button>}
              </div>;
            })}
          </div>
          <p className="mt-2 text-xs font-semibold" data-testid="paint-selected">{copy.selected}: {selectedChoice?.label ?? (selected === "erase" ? copy.erase : "—")}</p>
        </aside>
        <div className="min-w-0 overflow-x-auto" data-testid="paint-matrix" data-sort={rowSort}>
          <div className="mb-2 inline-flex rounded-lg border-2 border-neutral-700 p-1" role="group" aria-label={copy.sortLabel} data-testid="paint-sort">
            {([
              ["time", copy.sortClock],
              ["name", copy.sortName],
              ["position", copy.sortPosition],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" className={cn("touch-target min-h-11 rounded-md px-3 text-sm font-semibold", rowSort === id ? "bg-neutral-800 text-white" : "bg-white text-neutral-900")} aria-pressed={rowSort === id} onClick={() => setRowSort(id)} data-testid={`paint-sort-${id}`}>{label}</button>
            ))}
          </div>
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
                const label = edit?.family && edit.expected?.stationId === cell.stationId ?
                  (station ? displayStationLabel(locale, station) : cell.stationId ? boardStationLabel(locale, cell.stationId, day?.stations ?? []) : "") :
                  edit?.family ? `${PAINT_FAMILY_LABELS[edit.family]} · ${copy.auto}` :
                    station ? displayStationLabel(locale, station) : cell.kind === "off" ? t.timelineOffShift : t.timelineUnassigned;
                const dots = showLevels
                  ? eligibilityDots({
                    gaps,
                    shift,
                    hour,
                    kind: ended ? "off" : eligibilityCellKind(cell.kind, edit),
                  })
                  : [];
                const dotText = dots.map((dot) => {
                  const target = day?.stations.find((item) => item.id === dot.stationId);
                  const name = mandatoryGapLabel(target ?? { label: dot.stationId });
                  return dot.level === "training" ? `${name} entrenando` : name;
                }).join(", ");
                const openCell = !station;
                const frame = openCellOutlineClass({
                  mode: openCell && paletteStation ? (showLevels ? "owner" : "manager") : "rest",
                  mark: openCell && showLevels && paletteStation
                    ? markForStation({ abilities: shift.employee.abilities, stationId: paletteStation.id })
                    : "none",
                  color: paletteStation?.color ?? null,
                });
                const visibleLabel = openCell && !edit?.family ? "" : label;
                const stripe = station
                  ? breakStripeLabel(day?.breaks, shift.employee.id, shift.id, chicagoHourStart(date, hour), chicagoHourEnd(date, hour))
                  : null;
                return <td key={hour} className="border-b border-neutral-300 p-0.5 text-center" data-kind={cell.kind} data-pending={edit ? "1" : "0"}>
                  {cell.kind === "off" || ended ? <span className="block min-h-11 content-center text-neutral-500">{label}</span> : <button type="button" className={cn("relative touch-target min-h-11 w-full rounded border-2 px-1 text-xs font-bold leading-tight", station ? stationColorClass(station.color) : frame.className, edit && "ring-2 ring-inset ring-amber-700", readonly && "opacity-60")} disabled={readonly || busy} onClick={() => paint(shift, hour, false)} aria-label={`${personName(shift)}, ${formatHourLabel(hour)}, ${label}${dotText ? `, ${dotText}` : ""}${edit ? `, ${copy.pending(1)}` : ""}`} data-testid={`paint-cell-${shift.id}-${hour}`} data-outline={station ? undefined : frame.outline} data-wash={station ? undefined : frame.wash ? "1" : "0"}>{visibleLabel}{dots.length > 0 && <EligibilityDots shiftId={shift.id} hour={hour} dots={dots} stations={day?.stations ?? []} />}{edit && <span className="block text-[10px] uppercase">{locale === "es" ? "Pendiente" : "Pending"}</span>}<BreakStripe label={stripe} /></button>}
                </td>;
              })}
            </tr>)}</tbody>
            {day?.mandatory && <tfoot><tr data-testid="mandatory-gaps">
              <th className="sticky left-0 bg-white" scope="row" />
              {hours.map((hour) => {
                const boxes = gaps.filter((gap) => gap.hour === hour);
                return <td key={hour} className="align-top p-0.5" data-testid={`mandatory-gap-hour-${hour}`}>{boxes.map((gap) => {
                  const station = day.stations.find((item) => item.id === gap.stationId);
                  const label = mandatoryGapLabel(station ?? { label: gap.stationId });
                  return <span key={gap.stationId} className={cn("mb-0.5 block rounded px-0.5 text-center text-[10px] font-bold leading-4", station ? stationColorClass(station.color) : "bg-neutral-200")} data-testid={`mandatory-gap-${gap.stationId}-${hour}`}>{label}</span>;
                })}</td>;
              })}
            </tr></tfoot>}
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
