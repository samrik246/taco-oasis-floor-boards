"use client";

import { useCallback, useEffect, useState } from "react";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import type { DayBoardDto, ShiftDto } from "./types";

type Source = { startAt: string; endAt: string; employeeId: string; sourcePosition: string };
type Entry = {
  id: string; shiftId: string | null; externalId: string; date: string; board: string;
  sourcePosition: string; startAt: string; endAt: string; state: string;
  revision: number; savedCells: number; currentSource: Source | null;
  events: { action: string; managerName: string | null; reason: string; createdAt: string }[];
};
type Pending = { action: "remove"; shift: ShiftDto; futureCount: number } |
  { action: "restore"; entry: Entry; positions: "replay" | "none" };

function time(value: string) {
  return new Date(value).toLocaleTimeString("es-MX", {
    timeZone: "America/Chicago", hour: "numeric", minute: "2-digit",
  });
}

export function ShiftRemovalPanel({ day, board, date, managerToken, readonly, onSaved }: {
  day: DayBoardDto | null; board: "caja" | "cocina"; date: string;
  managerToken: string; readonly: boolean; onSaved: () => Promise<void>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/shift-removals?board=${board}&date=${date}`, {
      headers: managerAuthHeaders(managerToken), cache: "no-store",
    });
    if (!res.ok) { setEntries([]); return; }
    const data = await res.json() as { removals: Entry[] };
    setEntries(data.removals);
  }, [board, date, managerToken]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/shift-removals?board=${board}&date=${date}`, {
      headers: managerAuthHeaders(managerToken), cache: "no-store",
    }).then(async (res) => res.ok ? (await res.json() as { removals: Entry[] }).removals : [])
      .then((rows) => { if (!cancelled) setEntries(rows); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [board, date, managerToken]);

  async function submit() {
    if (!pending || !reason.trim() || busy || readonly) return;
    setBusy(true);
    setFeedback("");
    const body = pending.action === "remove"
      ? { action: "remove", shiftId: pending.shift.id, board, date,
          expected: { startAt: pending.shift.startAt, endAt: pending.shift.endAt,
            employeeId: pending.shift.employee.id, sourcePosition: pending.shift.sourcePosition },
          expectedRevision: entries.find((e) => e.shiftId === pending.shift.id)?.revision ?? 0,
          reason: reason.trim() }
      : { action: "restore", id: pending.entry.id,
          expected: pending.entry.currentSource, expectedRevision: pending.entry.revision,
          positions: pending.positions, reason: reason.trim() };
    try {
      const res = await fetch("/api/shift-removals", {
        method: "POST", headers: { "Content-Type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setFeedback(data.error ?? "El turno cambió. Actualiza y revisa antes de continuar.");
        await onSaved();
        await refresh();
        return;
      }
      setPending(null);
      setReason("");
      setFeedback(pending.action === "remove" ? "Turno quitado del tablero." : "Turno restaurado.");
      await onSaved();
      await refresh();
    } catch {
      setFeedback("No se pudo guardar. Actualiza y revisa antes de continuar.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="rounded-xl border border-neutral-300 p-4" data-testid="shift-removal-panel">
    <h2 className="text-lg font-bold">Quitar o restaurar turno</h2>
    <p className="text-sm">Solo cambia el tablero; no cambia When I Work. Elige el turno y confirma el motivo.</p>
    <div className="mt-3 space-y-2">
      {(day?.shifts ?? []).filter((s) => !s.supersededAt).map((shift) => <div key={shift.id}
        className="flex flex-wrap items-center justify-between gap-2 rounded border p-2" data-testid={`shift-removal-row-${shift.id}`}>
        <span>{shift.employee.firstName} {shift.employee.lastName} · {shift.sourcePosition} · {date} · {time(shift.startAt)}–{time(shift.endAt)}</span>
        <button type="button" disabled={readonly || busy} className="rounded border px-2 py-1 font-semibold"
          onClick={() => { setPending({ action: "remove", shift,
            futureCount: shift.assignments.filter((a) => new Date(a.hourStart).getTime() > Date.now()).length });
            setReason(""); setFeedback(""); }}>
          Quitar turno
        </button>
      </div>)}
    </div>
    {entries.filter((e) => e.state === "removed").map((entry) => <div key={entry.id}
      className="mt-3 rounded border border-amber-500 p-2" data-testid={`removed-shift-${entry.id}`}>
      <p>{entry.externalId} · {entry.sourcePosition} · {entry.date} · {time(entry.startAt)}–{time(entry.endAt)}</p>
      <p className="text-sm">{entry.currentSource ? `${entry.savedCells} posiciones guardadas para revisar` : "La fuente ya no contiene este turno; importa un horario vigente antes de restaurar."}</p>
      {entry.events.map((event, i) => <p className="text-sm" key={i}>
        {event.action} · {event.managerName ?? "Importación"} · {event.reason} · {event.createdAt}
      </p>)}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={readonly || busy || !entry.currentSource}
          onClick={() => { setPending({ action: "restore", entry, positions: "replay" }); setReason(""); setFeedback(""); }}>
          Restaurar con posiciones
        </button>
        <button type="button" disabled={readonly || busy || !entry.currentSource}
          onClick={() => { setPending({ action: "restore", entry, positions: "none" }); setReason(""); setFeedback(""); }}>
          Restaurar sin posiciones
        </button>
      </div>
    </div>)}
    {pending && <div className="mt-3 rounded border-2 border-amber-600 p-3" data-testid="shift-removal-confirm">
      <p className="font-bold">{pending.action === "remove"
        ? `Quitar solo este turno; se liberarán ${pending.futureCount} posiciones futuras.`
        : pending.positions === "replay" ? `Restaurar este turno y validar ${pending.entry.savedCells} posiciones guardadas.`
          : "Restaurar solo el turno; las posiciones se volverán a pintar."}</p>
      <label className="mt-2 block">Motivo
        <textarea className="block w-full rounded border p-2" value={reason} maxLength={500}
          onChange={(event) => setReason(event.target.value)} data-testid="shift-removal-reason" />
      </label>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={busy || readonly || !reason.trim()} onClick={() => void submit()}
          data-testid="shift-removal-submit">Confirmar</button>
        <button type="button" disabled={busy} onClick={() => setPending(null)}>Cancelar</button>
      </div>
    </div>}
    {feedback && <p role="status" className="mt-2" data-testid="shift-removal-feedback">{feedback}</p>}
  </section>;
}
