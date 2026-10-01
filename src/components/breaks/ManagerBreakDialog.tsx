"use client";

import { useEffect, useRef, useState } from "react";
import { breakClock, breakRange, unavailableLabel, approvalLine, stateLabel, statusClass, type Approval, type BreakStatus, type BreakOption } from "@/lib/breaks/display";
import type { ManagerBreakCover } from "@/lib/breaks/cover-positions";
import { CoverPositionDetails } from "./CoverPositionDetails";
import type { Locale } from "@/lib/i18n";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import {
  breakLengthMinutes,
  breakLengthsForStart,
  breakQuarterFaces,
  managerShiftLine,
  preferredBreakLength,
  type BreakChoice,
} from "@/lib/breaks/picker-steps";

type Slot = { startAt: string; endAt: string };

type CoverChoice = Omit<Extract<ManagerBreakCover, { kind: "simple" }>, "positions"> & Partial<Pick<ManagerBreakCover, "positions">>
  | Omit<Extract<ManagerBreakCover, { kind: "shuffle" }>, "positions"> & Partial<Pick<ManagerBreakCover, "positions">>;

type Managed = {
  state?: BreakStatus["state"] | "absent";
  approval?: Approval | null;
  firstName: string;
  allowanceMinutes: number;
  row: "absent" | "this" | "other";
  shifts: Slot[];
  blocked: { startAt: string; endAt: string; reason: "blackout" | "overlap" }[];
  slots: BreakOption[];
  saved: Slot | null;
  pending: Slot | null;
  auto?: boolean;
  covers: CoverChoice[];
  stations?: { id: string; label: string }[];
  pendingRevision?: { id: string; updatedAt: string } | null;
  alternatives?: (BreakOption & { cover: CoverChoice | null })[];
};

function coverLabel(cover: CoverChoice, locale: Locale): string {
  return cover.kind === "simple" ? cover.firstName : `${cover.moves[0].firstName} ${locale === "es" ? "y" : "and"} ${cover.moves[1].firstName}`;
}

function clock(iso: string): string {
  return breakClock(iso);
}

/** Pintar break dialog. A save or clear reloads the day and leaves the paint draft alone. */
export function ManagerBreakDialog({
  board,
  employeeId,
  name,
  managerToken,
  onClose,
  onExit,
  onSaved,
  locale = "es",
  onDenied,
}: {
  board: "caja" | "cocina";
  employeeId: string;
  name: string;
  managerToken: string;
  onClose: () => void;
  /** Full BREAK exit; ordinary Pintar callers retain dialog-only dismissal. */
  onExit?: () => void;
  onSaved: () => Promise<void>;
  locale?: Locale;
  onDenied?: () => void;
}) {
  const es = locale === "es";
  const [mine, setMine] = useState<Managed | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosenStart, setChosenStart] = useState<string | null>(null);
  const [chosenEnd, setChosenEnd] = useState<string | null>(null);
  const [covers, setCovers] = useState<CoverChoice[]>([]);
  const [coverWindow, setCoverWindow] = useState<Slot | null>(null);
  const [autoPick, setAutoPick] = useState(false);
  const [actingCover, setActingCover] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);
  function dismiss(exit = false) {
    generation.current += 1;
    if (exit && onExit) onExit();
    else onClose();
  }
  function back() {
    if (chosenStart) { setChosenStart(null); setChosenEnd(null); }
    else dismiss();
  }

  useEffect(() => {
    const version = ++generation.current;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/breaks/manage?board=${board}&employeeId=${encodeURIComponent(employeeId)}`,
          { headers: managerAuthHeaders(managerToken) },
        );
        const body = await response.json() as Managed & { error?: string };
        if (cancelled || version !== generation.current) return;
        if ((response.status === 401 || response.status === 403) && onDenied) { onDenied(); return; }
        if (!response.ok) {
          setMessage(body.error ?? (es ? "No se pudo abrir BREAK." : "Could not open BREAK."));
          return;
        }
        setMessage("");
        setMine(body);
        setCovers(body.covers ?? []);
        setAutoPick(body.auto === true);
        setCoverWindow(body.pending ?? (body.auto ? body.saved : null));
        if (body.row === "other") setMessage(es ? "Ese BREAK es de la otra área." : "That BREAK is in the other area.");
      } catch {
        if (!cancelled && version === generation.current) setMessage(es ? "No se pudo abrir BREAK." : "Could not open BREAK.");
      } finally {
        if (!cancelled && version === generation.current) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      generation.current += 1;
    };
  }, [board, employeeId, managerToken, onDenied, es, reloadKey]);

  async function commit(response: Response, fallback: string, slot: Slot | null, version: number) {
    if (version !== generation.current) return;
    if ((response.status === 401 || response.status === 403) && onDenied) { onDenied(); return; }
    const body = await response.json() as { error?: string; waiting?: boolean; message?: string; covers?: CoverChoice[]; managed?: Managed };
    if (version !== generation.current) return;
    if (!response.ok) {
      setMessage(body.error ?? fallback);
      setBusy(false);
      return;
    }
    if (body.waiting) {
      setMessage(es ? (body.message ?? "Requiere aprobación del gerente.") : "Gerente approval required.");
      setCovers(body.managed?.covers ?? body.covers ?? []);
      setCoverWindow(body.managed?.pending ?? slot);
      setAutoPick(false);
      setMine(current => body.managed ?? (current ? { ...current, saved: null, pending: slot, state: "pending", approval: "gerente", alternatives: [], pendingRevision: null } : current));
      setChosenStart(null);
      setChosenEnd(null);
      try { await onSaved(); } catch { if (version === generation.current) setMessage(es ? "No se pudo actualizar" : "Could not refresh"); }
      if (version === generation.current) setBusy(false);
      return;
    }
    try {
      await onSaved();
      if (version === generation.current) dismiss();
    } catch {
      if (version !== generation.current) return;
      setMessage(es ? "No se pudo actualizar" : "Could not refresh");
      setBusy(false);
    }
  }

  async function save(slot: BreakChoice, cover?: { employeeId: string; shuffleEmployeeId?: string }, resolvePending = false) {
    if (busy) return;
    const version = generation.current;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/breaks/manage", {
        method: "POST",
        headers: { "content-type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify({
          board,
          employeeId,
          startAt: slot.startAt,
          endAt: slot.endAt,
          ...(resolvePending ? { resolvePending: mine?.pendingRevision } : {}),
          ...(cover ? { coverEmployeeId: cover.employeeId, shuffleEmployeeId: cover.shuffleEmployeeId } : {}),
        }),
      });
      await commit(response, es ? "Elige otro horario." : "Choose another time.", slot, version);
    } catch {
      if (version !== generation.current) return;
      setMessage(es ? "No se pudo actualizar" : "Could not refresh");
      setBusy(false);
    }
  }

  async function replaceCover(cover: { employeeId: string; shuffleEmployeeId?: string }) {
    if (busy) return;
    const version = generation.current;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/breaks/manage", {
        method: "POST",
        headers: { "content-type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify({
          board,
          employeeId,
          replaceAuto: true,
          coverEmployeeId: cover.employeeId,
          ...(cover.shuffleEmployeeId ? { shuffleEmployeeId: cover.shuffleEmployeeId } : {}),
        }),
      });
      await commit(response, es ? "Esa persona no puede cubrir." : "That person cannot cover.", null, version);
    } catch {
      if (version !== generation.current) return;
      setMessage(es ? "No se pudo actualizar" : "Could not refresh");
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setActingCover(null);
    const version = generation.current;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/breaks/manage", {
        method: "DELETE",
        headers: { "content-type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify({ board, employeeId }),
      });
      await commit(response, es ? "No se pudo quitar." : "Could not cancel.", null, version);
    } catch {
      if (version !== generation.current) return;
      setMessage(es ? "No se pudo actualizar" : "Could not refresh");
      setBusy(false);
    }
  }

  const lengths = mine && chosenStart ? breakLengthsForStart(mine.slots, chosenStart) : [];
  const selected = chosenEnd
    ? lengths.find((slot) => slot.endAt === chosenEnd) ?? preferredBreakLength(lengths, mine?.allowanceMinutes ?? 0)
    : preferredBreakLength(lengths, mine?.allowanceMinutes ?? 0);
  const showingLengths = selected != null;
  const faces = mine ? breakQuarterFaces({ shifts: mine.shifts, slots: mine.slots, blocked: mine.blocked }) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="descanso-title" data-testid="descanso-dialog" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); back(); } }}>
      <div className="max-h-[96vh] w-full max-w-none overflow-y-auto rounded-lg border-2 border-neutral-900 bg-white p-4">
        <h3 id="descanso-title" className="text-lg font-bold" data-testid="descanso-name">BREAK · {name}</h3>
        {mine && (
          <p className="mt-1 text-sm font-semibold" data-testid="descanso-shift">
            {es ? managerShiftLine(mine.firstName, mine.shifts, mine.allowanceMinutes, clock) : `${mine.firstName}. ${[...mine.shifts].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)).map(breakRange).join(" and ")}. Up to ${mine.allowanceMinutes} minutes.`}
          </p>
        )}
        {mine && <p className={`mt-3 rounded-xl border-2 p-3 text-xl font-black ${mine.state && mine.state !== "absent" ? statusClass[mine.state] : "border-neutral-300"}`} data-testid="descanso-status">
          {mine.state === "pending" ? (es ? "Pendiente · Por aprobar" : "Pending · Needs approval") : mine.state === "reserved" ? (es ? "Reservado · Aprobado" : "Reserved · Approved") : stateLabel(locale, mine.state ?? "absent")}
        </p>}
        {mine?.saved && (
          <p className="mt-2 text-base font-bold" data-testid="descanso-current">
            {breakRange(mine.saved)}
            {autoPick ? " auto" : ""}
          </p>
        )}
        {message && <p className="mt-2 rounded-md border-2 border-neutral-950 px-2 py-1 text-base font-bold" role="alert" data-testid="descanso-message">{message}</p>}
        {coverWindow && <p className="mt-3 text-xl font-bold">{es ? "Solicitud" : "Request"}: {clock(coverWindow.startAt)} – {clock(coverWindow.endAt)}</p>}
        {covers.length === 0 && coverWindow && <p>{es ? "No hay cobertura disponible ahora. Puedes rechazar o volver a revisar." : "No cover available now. Reject or check again later."}</p>}
        {coverWindow && !autoPick && <button type="button" className="mt-2 min-h-12 rounded-xl border-2 px-4 font-bold" disabled={busy} data-testid="descanso-recheck" onClick={() => { setBusy(true); setReloadKey(key => key + 1); }}>{es ? "Volver a revisar" : "Check again"}</button>}
        {coverWindow && covers.length === 0 && mine?.pendingRevision && <section className="mt-3 space-y-2" data-testid="descanso-alternatives">
          <h4 className="text-lg font-bold">{es ? "Otros horarios · misma duración" : "Other times · same duration"}</h4>
          {!mine.alternatives?.length && <p>{es ? "No hay otro horario con aprobación disponible. La solicitud sigue pendiente." : "No other approvable time is available. The request remains pending."}</p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{mine.alternatives?.map(slot => <button type="button" key={slot.startAt} disabled={busy} data-testid="descanso-alternative" data-start={slot.startAt} data-end={slot.endAt}
            className="min-h-20 rounded-xl border-2 border-green-800 bg-green-50 p-3 text-left text-green-950 disabled:opacity-60"
            onClick={() => { const cover = slot.cover; void save(slot, cover ? cover.kind === "simple" ? { employeeId: cover.employeeId } : { employeeId: cover.moves[0].employeeId, shuffleEmployeeId: cover.moves[1].employeeId } : undefined, true); }}>
            <span className="block text-lg font-bold">{es ? "Mover y aprobar" : "Move and approve"} · {breakRange(slot)} · {breakLengthMinutes(slot)} min</span>
            <span className="block font-bold">{slot.cover ? `${slot.cover.kind === "shuffle" ? es ? "Mezclar" : "Shuffle" : es ? "Cubrir" : "Cover"} · ${coverLabel(slot.cover, locale)}` : approvalLine(locale, "automatic")}</span>
            {slot.cover && <CoverPositionDetails positions={slot.cover.positions} stations={mine.stations ?? []} locale={locale} />}
          </button>)}</div>
        </section>}
        {covers.length > 0 && coverWindow && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {covers.map((cover) => {
              const key = cover.kind === "simple" ? cover.employeeId : `${cover.moves[0].employeeId}-${cover.moves[1].employeeId}`;
              return (
                <button
                  key={key}
                  type="button"
                  className={`touch-target min-h-16 rounded-xl border-2 px-4 py-3 text-left text-lg font-bold disabled:opacity-60 [overflow-wrap:anywhere] ${cover.kind === "simple" ? "border-green-800 bg-green-50 text-green-950" : "border-blue-800 bg-blue-50 text-blue-950"} ${busy && actingCover === key ? "ring-4 ring-neutral-950" : ""}`}
                  aria-pressed={busy && actingCover === key}
                  data-testid="descanso-cover"
                  data-kind={cover.kind}
                  data-cover={cover.kind === "simple" ? cover.employeeId : cover.moves[0].employeeId}
                  data-shuffle={cover.kind === "shuffle" ? cover.moves[1].employeeId : ""}
                  disabled={busy}
                  onClick={() => {
                    setActingCover(key);
                    const named = cover.kind === "simple"
                      ? { employeeId: cover.employeeId }
                      : { employeeId: cover.moves[0].employeeId, shuffleEmployeeId: cover.moves[1].employeeId };
                    if (autoPick) void replaceCover(named);
                    else void save(coverWindow, named);
                  }}
                >
                  {cover.kind === "shuffle" ? (es ? "Mezclar" : "Shuffle") : (es ? "Cubrir" : "Cover")} · {coverLabel(cover, locale)}
                  <CoverPositionDetails positions={cover.positions} stations={mine?.stations ?? []} locale={locale} />
                  <span className="block text-sm">{busy && actingCover === key ? (es ? "Guardando…" : "Saving…") : (es ? "Aprobar con esta cobertura" : "Approve with this cover")}</span>
                </button>
              );
            })}
          </div>
        )}
        {faces.length > 0 && !showingLengths && !coverWindow && (
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {faces.map((face) => (
              <button
                key={face.startAt}
                type="button"
                className="touch-target min-h-11 rounded-lg border-2 border-neutral-950 px-2 text-base font-bold disabled:opacity-40"
                data-testid="descanso-start"
                data-start={face.startAt}
                data-reason={face.reason ?? ""}
                disabled={busy || face.disabled}
                onClick={() => {
                  setChosenEnd(null);
                  setChosenStart(face.startAt);
                }}
              >
                <span className="block">{clock(face.startAt)}</span>
                {face.reason && <span className="block text-xs font-semibold">{unavailableLabel(locale)}</span>}
              </button>
            ))}
          </div>
        )}
        {showingLengths && selected && (
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" className="touch-target min-h-11 rounded-lg border-2 border-neutral-950 text-base font-bold" data-testid="descanso-start-back" disabled={busy} onClick={() => { setChosenEnd(null); setChosenStart(null); }}>
              {es ? "Otro inicio" : "Different start"}
            </button>
            <button
              type="button"
              className="touch-target min-h-11 rounded-lg border-2 border-neutral-950 bg-neutral-950 px-3 font-bold text-white disabled:opacity-40"
              data-testid="descanso-save"
              data-start={selected.startAt}
              data-end={selected.endAt}
              disabled={busy}
              onClick={() => void save(selected)}
            >
              <span className="block">{es ? "RESERVAR" : "RESERVE"}</span>
              <span className="block text-sm font-semibold">{breakRange(selected)}, {breakLengthMinutes(selected)} min</span>
              <span className="block">{approvalLine(locale, (selected as BreakOption).approval ?? "gerente", true)}</span>
            </button>
            {lengths.filter((slot) => slot.endAt !== selected.endAt).length > 0 && (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {lengths.filter((slot) => slot.endAt !== selected.endAt).map((slot) => (
                  <button
                    key={`${slot.startAt}-${slot.endAt}`}
                    type="button"
                    className="touch-target min-h-11 rounded-lg border-2 border-neutral-950 text-base font-bold"
                    data-testid="descanso-slot"
                    data-start={slot.startAt}
                    data-end={slot.endAt}
                    disabled={busy}
                    onClick={() => setChosenEnd(slot.endAt)}
                  >
                    {breakLengthMinutes(slot)} min
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="sticky bottom-0 mt-4 flex flex-wrap justify-end gap-2 border-t-2 border-neutral-200 bg-white pt-3">
          <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 font-bold" data-testid="descanso-back" onClick={back}>{es ? "Atrás" : "Back"}</button>
          {(mine?.saved || mine?.pending || coverWindow) && (
            <button type="button" className="touch-target min-h-12 rounded-md border-2 border-red-800 bg-red-50 px-3 font-bold text-red-950 disabled:opacity-40" data-testid="descanso-clear" disabled={busy} onClick={() => void clear()}>
              {(mine?.pending || (coverWindow && !autoPick)) ? (es ? "Rechazar solicitud" : "Reject request") : (es ? "Quitar BREAK" : "Cancel BREAK")}
            </button>
          )}
          <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 font-bold" data-testid="descanso-close" onClick={() => dismiss(true)}>
            {onExit ? (es ? "Cerrar · Volver al tablero" : "Close · Back to board") : (es ? "Cerrar" : "Close")}
          </button>
        </div>
      </div>
    </div>
  );
}
