"use client";

import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import {
  breakLengthMinutes,
  breakLengthsForStart,
  breakQuarterFaces,
  breakSaveLine,
  managerShiftLine,
  preferredBreakLength,
  type BreakChoice,
} from "@/lib/breaks/picker-steps";
import { TIMEZONE } from "@/lib/constants";

type Slot = { startAt: string; endAt: string };

type Managed = {
  firstName: string;
  allowanceMinutes: number;
  row: "absent" | "this" | "other";
  shifts: Slot[];
  blocked: { startAt: string; endAt: string; reason: "blackout" | "overlap" }[];
  slots: Slot[];
  saved: Slot | null;
};

function clock(iso: string): string {
  return formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");
}

/** Pintar break dialog. A save or clear reloads the day and leaves the paint draft alone. */
export function ManagerBreakDialog({
  board,
  employeeId,
  name,
  managerToken,
  onClose,
  onSaved,
}: {
  board: "caja" | "cocina";
  employeeId: string;
  name: string;
  managerToken: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [mine, setMine] = useState<Managed | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosenStart, setChosenStart] = useState<string | null>(null);
  const [chosenEnd, setChosenEnd] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/breaks/manage?board=${board}&employeeId=${encodeURIComponent(employeeId)}`,
          { headers: managerAuthHeaders(managerToken) },
        );
        const body = await response.json() as Managed & { error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setMessage(body.error ?? "No se pudo abrir el descanso.");
          return;
        }
        setMine(body);
        if (body.row === "other") setMessage("Ese descanso es de la otra área.");
      } catch {
        if (!cancelled) setMessage("No se pudo abrir el descanso.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [board, employeeId, managerToken]);

  async function commit(response: Response, fallback: string) {
    const body = await response.json() as { error?: string };
    if (!response.ok) {
      setMessage(body.error ?? fallback);
      setBusy(false);
      return;
    }
    try {
      await onSaved();
      onClose();
    } catch {
      setMessage("No se pudo actualizar");
      setBusy(false);
    }
  }

  async function save(slot: BreakChoice) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/breaks/manage", {
        method: "POST",
        headers: { "content-type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify({ board, employeeId, startAt: slot.startAt, endAt: slot.endAt }),
      });
      await commit(response, "Elige otro horario.");
    } catch {
      setMessage("No se pudo actualizar");
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/breaks/manage", {
        method: "DELETE",
        headers: { "content-type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify({ board, employeeId }),
      });
      await commit(response, "No se pudo quitar.");
    } catch {
      setMessage("No se pudo actualizar");
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="descanso-title" data-testid="descanso-dialog">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border-2 border-neutral-900 bg-white p-4">
        <h3 id="descanso-title" className="text-lg font-bold" data-testid="descanso-name">{name}</h3>
        {mine && (
          <p className="mt-1 text-sm font-semibold" data-testid="descanso-shift">
            {managerShiftLine(mine.firstName, mine.shifts, mine.allowanceMinutes, clock)}
          </p>
        )}
        {mine?.saved && (
          <p className="mt-2 text-sm font-bold" data-testid="descanso-current">
            {clock(mine.saved.startAt)} a {clock(mine.saved.endAt)}
          </p>
        )}
        {message && <p className="mt-2 rounded-md border-2 border-neutral-950 px-2 py-1 text-sm font-bold" role="alert" data-testid="descanso-message">{message}</p>}
        {faces.length > 0 && !showingLengths && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {faces.map((face) => (
              <button
                key={face.startAt}
                type="button"
                className="touch-target min-h-11 rounded-lg border-2 border-neutral-950 px-2 text-sm font-bold disabled:opacity-40"
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
                {face.reason && <span className="block text-xs font-semibold">{face.reason}</span>}
              </button>
            ))}
          </div>
        )}
        {showingLengths && selected && (
          <div className="mt-3 flex flex-col gap-2">
            <button type="button" className="touch-target min-h-11 rounded-lg border-2 border-neutral-950 text-sm font-bold" data-testid="descanso-start-back" disabled={busy} onClick={() => { setChosenEnd(null); setChosenStart(null); }}>
              Otro inicio
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
              <span className="block">Guardar</span>
              <span className="block text-sm font-semibold">{breakSaveLine(selected, clock)}</span>
            </button>
            {lengths.filter((slot) => slot.endAt !== selected.endAt).length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {lengths.filter((slot) => slot.endAt !== selected.endAt).map((slot) => (
                  <button
                    key={`${slot.startAt}-${slot.endAt}`}
                    type="button"
                    className="touch-target min-h-11 rounded-lg border-2 border-neutral-950 text-sm font-bold"
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
          {mine?.saved && (
            <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 font-bold" data-testid="descanso-clear" disabled={busy} onClick={() => void clear()}>
              Quitar
            </button>
          )}
          <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 font-bold" data-testid="descanso-close" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
