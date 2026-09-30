"use client";

import { useEffect, useRef, useState } from "react";
import { breakClock, breakRange, unavailableLabel, approvalLine, stateLabel, type Approval, type BreakStatus, type BreakOption } from "@/lib/breaks/display";
import type { Locale } from "@/lib/i18n";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import {
  breakLengthMinutes,
  breakLengthsForStart,
  breakQuarterFaces,
  preferredBreakLength,
  type BreakChoice,
} from "@/lib/breaks/picker-steps";

type Slot = { startAt: string; endAt: string };

type CoverChoice =
  | { kind: "simple"; employeeId: string; shiftId: string; firstName: string }
  | { kind: "shuffle"; moves: [{ employeeId: string; shiftId: string; firstName: string }, { employeeId: string; shiftId: string; firstName: string }] };

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
        setMine(body);
        setCovers(body.covers ?? []);
        setAutoPick(body.auto === true);
        setCoverWindow(body.pending ?? (body.auto ? body.saved : null));
        if (body.row === "other") setMessage(es ? "Ese BREAK es de la otra área." : "That BREAK is in the other area.");
      } catch {
        if (!cancelled && version === generation.current) setMessage(es ? "No se pudo abrir BREAK." : "Could not open BREAK.");
      }
    })();
    return () => {
      cancelled = true;
      generation.current += 1;
    };
  }, [board, employeeId, managerToken, onDenied, es]);

  async function commit(response: Response, fallback: string, slot: Slot | null, version: number) {
    if (version !== generation.current) return;
    if ((response.status === 401 || response.status === 403) && onDenied) { onDenied(); return; }
    const body = await response.json() as { error?: string; waiting?: boolean; message?: string; covers?: CoverChoice[] };
    if (version !== generation.current) return;
    if (!response.ok) {
      setMessage(body.error ?? fallback);
      setBusy(false);
      return;
    }
    if (body.waiting) {
      setMessage(es ? (body.message ?? "Requiere aprobación del gerente.") : "Gerente approval required.");
      setCovers(body.covers ?? []);
      setCoverWindow(slot);
      setAutoPick(false);
      setMine(current => current ? { ...current, saved: null, pending: slot, state: "pending", approval: "gerente" } : current);
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

  async function save(slot: BreakChoice, cover?: { employeeId: string; shuffleEmployeeId?: string }) {
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
            {mine.firstName}. {[...mine.shifts].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)).map(breakRange).join(es ? " y " : " and ")}. {es ? `Le tocan ${mine.allowanceMinutes} minutos.` : `Up to ${mine.allowanceMinutes} minutes.`}
          </p>
        )}
        {mine && <p className="mt-2 text-xl font-bold">{stateLabel(locale, mine.state ?? "absent")}{mine.approval ? ` · ${approvalLine(locale, mine.approval)}` : ""}</p>}
        {mine?.saved && (
          <p className="mt-2 text-base font-bold" data-testid="descanso-current">
            {breakRange(mine.saved)}
            {autoPick ? " auto" : ""}
          </p>
        )}
        {message && <p className="mt-2 rounded-md border-2 border-neutral-950 px-2 py-1 text-base font-bold" role="alert" data-testid="descanso-message">{message}</p>}
        {coverWindow && <p className="mt-3 text-xl font-bold">{es ? "Solicitud" : "Request"}: {clock(coverWindow.startAt)} – {clock(coverWindow.endAt)} · {es ? "Visible para el gerente." : "Visible to the gerente."}</p>}
        {covers.length === 0 && coverWindow && <p>{es ? "No hay cobertura disponible ahora. Puedes rechazar o volver a revisar." : "No cover available now. Reject or check again later."}</p>}
        {covers.length > 0 && coverWindow && (
          <div className="mt-3 flex flex-col gap-2">
            {covers.map((cover) => {
              const key = cover.kind === "simple" ? cover.employeeId : `${cover.moves[0].employeeId}-${cover.moves[1].employeeId}`;
              return (
                <button
                  key={key}
                  type="button"
                  className="touch-target min-h-11 rounded-lg border-2 border-neutral-950 px-3 text-base font-bold disabled:opacity-40"
                  data-testid="descanso-cover"
                  data-kind={cover.kind}
                  data-cover={cover.kind === "simple" ? cover.employeeId : cover.moves[0].employeeId}
                  data-shuffle={cover.kind === "shuffle" ? cover.moves[1].employeeId : ""}
                  disabled={busy}
                  onClick={() => {
                    const named = cover.kind === "simple"
                      ? { employeeId: cover.employeeId }
                      : { employeeId: cover.moves[0].employeeId, shuffleEmployeeId: cover.moves[1].employeeId };
                    if (autoPick) void replaceCover(named);
                    else void save(coverWindow, named);
                  }}
                >
                  {cover.kind === "shuffle" ? "Shuffle" : (es ? "Cubrir" : "Cover")} · {coverLabel(cover, locale)}
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
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 font-bold" data-testid="descanso-back" onClick={back}>{es ? "Atrás" : "Back"}</button>
          {(mine?.saved || mine?.pending || coverWindow) && (
            <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 font-bold" data-testid="descanso-clear" disabled={busy} onClick={() => void clear()}>
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
