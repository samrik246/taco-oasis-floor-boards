"use client";

import { PendingQuarterActions } from "./PendingQuarterActions";
import { capabilities } from "@/lib/quarter/client/transport";
import { savedAction } from "@/lib/quarter/client/controls";
import type { PublicDayV2 } from "@/lib/quarter/client/day";
import { useCallback, useEffect, useState } from "react";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import type { DayBoardDto, ShiftDto } from "./types";

type Source = { startAt: string; endAt: string; employeeId: string; sourcePosition: string };
type SavedCell = { id: string; stationId: string; hourStart: string; hourEnd: string };
type Event = { action: string; revision: number; managerName: string | null;
  reason: string; createdAt: string; source: { startAt: string; endAt: string };
  cells: SavedCell[] | { cells: SavedCell[]; positions: string } };
type Entry = {
  id: string; shiftId: string | null; externalId: string; date: string; board: string;
  sourcePosition: string; startAt: string; endAt: string; state: string;
  revision: number; savedCells: number; savedMinutes?:number; currentSource: Source | null;
  events: Event[];
};
type Review={actorId:string;snapshot:Pick<PublicDayV2,"databaseEpoch"|"worldRevision"|"phase"|"capabilitySha256">;sources:{shiftId:string;sourceSha256:string;removalRevision:number}[]};
type Pending = ({ action: "remove"; shift: ShiftDto; futureCount: number;futureMinutes?:number } |
  { action: "restore"; entry: Entry; positions: "replay" | "none" } |
  { action: "resolve"; entry: Entry }) & {review?:Review|null};

function time(value: string) {
  return new Date(value).toLocaleTimeString("es-MX", {
    timeZone: "America/Chicago", hour: "numeric", minute: "2-digit",
  });
}

function eventCells(event: Event): SavedCell[] {
  return Array.isArray(event.cells) ? event.cells : event.cells.cells;
}

function History({ events }: { events: Event[] }) {
  return <div className="mt-2 space-y-1">
    {events.map((event) => <p className="text-sm" key={event.revision}>
      v{event.revision} · {event.action} · {event.managerName ?? "Importación"} · {event.reason} · {event.createdAt}
      {event.source?.startAt && <> · {time(event.source.startAt)}–{time(event.source.endAt)}</>}
      {eventCells(event).length > 0 && <> · {eventCells(event).map((cell) =>
        `${cell.stationId} ${time(cell.hourStart)}–${time(cell.hourEnd)}`).join(", ")}</>}
    </p>)}
  </div>;
}

export function ShiftRemovalPanel({ day, board, date, managerToken, readonly, onSaved }: {
  day: DayBoardDto | null; board: "caja" | "cocina"; date: string;
  managerToken: string; readonly: boolean; onSaved: () => Promise<void>;
}) {
  const [review,setReview]=useState<Review|null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const read = useCallback(async()=>{
    const cap=await capabilities();
    const res=await fetch(`${cap.phase==="active"?"/api/v2":"/api"}/shift-removals?board=${board}&date=${date}`,{headers:managerAuthHeaders(managerToken),cache:"no-store"});
    if(!res.ok)throw new Error("No se pudo cargar la revisión de turnos.");
    return await res.json() as {removals:Entry[]}&Partial<Review>;
  },[board,date,managerToken]);
  const refresh=useCallback(async()=>{const result=await read();setEntries(result.removals);setReview(result.snapshot?result as Review:null);},[read]);
  useEffect(()=>{
    let cancelled=false;
    void read().then(result=>{if(!cancelled){setEntries(result.removals);setReview(result.snapshot?result as Review:null);}})
      .catch(error=>{if(!cancelled){setEntries([]);setReview(null);setFeedback(error.message);}});
    return ()=>{cancelled=true;};
  },[read]);
  function begin(value:Pending){setPending({...value,review});}

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
      : pending.action === "restore" ? { action: "restore", id: pending.entry.id,
          expected: pending.entry.currentSource, expectedRevision: pending.entry.revision,
          positions: pending.positions, reason: reason.trim() }
        : { action: "resolve", id: pending.entry.id,
          expectedRevision: pending.entry.revision, reason: reason.trim() };
    try {
      if(pending.review){
        const r=pending.review,shiftId=pending.action==="remove"?pending.shift.id:pending.entry.shiftId;
        const expected=pending.action==="resolve"?{databaseEpoch:r.snapshot.databaseEpoch,worldRevision:r.snapshot.worldRevision,removalRevision:pending.entry.revision}:
          {...r.sources.find(s=>s.shiftId===shiftId),databaseEpoch:r.snapshot.databaseEpoch,worldRevision:r.snapshot.worldRevision};
        if("shiftId" in expected)delete expected.shiftId;
        const action={operation:pending.action,board,reason:reason.trim(),expected,...(pending.action==="resolve"?{removalId:pending.entry.id}:{shiftId}),...(pending.action==="restore"?{positions:pending.positions}:{})};
        const result=await savedAction({managerId:r.actorId,board,date},r.snapshot,"shift-removals",action,managerToken);
        if(result.status!=="saved"&&result.status!=="cleanup-pending"){setFeedback(result.status==="rejected"?`Rechazado: ${String(result.body?.code??"")}`:"Guardado sin confirmar. Reintentar conserva la solicitud original.");return;}
        setPending(null);setReason("");setFeedback(result.status==="saved"?"Cambio de turno guardado.":"Guardado; limpieza local pendiente.");await onSaved();await refresh();return;
      }
      if(day?.quarter)throw new Error("La revisión compatible no está disponible.");
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
      setFeedback(pending.action === "remove" ? "Turno quitado del tablero."
        : pending.action === "restore" ? "Turno restaurado."
          : "Bloqueo de importación liberado; revisa el nuevo turno al importar.");
      await onSaved();
      await refresh();
    } catch {
      setFeedback("No se pudo guardar. Actualiza y revisa antes de continuar.");
    } finally {
      setBusy(false);
    }
  }

  const removedCount = entries.filter((entry) => entry.state === "removed").length;
  const foldLabel = removedCount > 0
    ? `Quitar o restaurar turno (${removedCount} quitados)`
    : "Quitar o restaurar turno";

  return <section className="rounded-xl border border-neutral-300 p-4" data-testid="shift-removal-panel">
    {review&&<PendingQuarterActions key={`${review.actorId}|${board}|${date}`} managerId={review.actorId} board={board} date={date} token={managerToken} locale="es" readonly={readonly||busy} onSaved={async()=>{await onSaved();await refresh();}} />}
    <button type="button" className="w-full text-left text-lg font-bold" aria-expanded={open}
      onClick={() => setOpen((value) => !value)} data-testid="shift-removal-toggle">
      {foldLabel}
    </button>
    {open && <>
    <p className="text-sm">Solo cambia el tablero; no cambia When I Work. Elige el turno y confirma el motivo.</p>
    <div className="mt-3 space-y-2">
      {(day?.shifts ?? []).filter((s) => !s.supersededAt).map((shift) => <div key={shift.id}
        className="flex flex-wrap items-center justify-between gap-2 rounded border p-2" data-testid={`shift-removal-row-${shift.id}`}>
        <span>{shift.employee.firstName} {shift.employee.lastName} · {shift.sourcePosition} · {date} · {time(shift.startAt)}–{time(shift.endAt)}</span>
        <button type="button" disabled={readonly || busy} className="rounded border px-2 py-1 font-semibold"
          onClick={() => { begin({ action: "remove", shift,
            futureCount: shift.assignments.filter((a) => new Date(a.hourStart).getTime() > Date.now()).length,
            ...(shift.paintHours?{futureMinutes:shift.paintHours.filter(h=>Date.parse(h.hourStart)>Date.now()).flatMap(h=>h.intervals).filter(i=>i.state==="assigned").reduce((n,i)=>n+(Date.parse(i.endAt)-Date.parse(i.startAt))/60000,0)}:{}) });
            setReason(""); setFeedback(""); }}>
          Quitar turno
        </button>
      </div>)}
    </div>
    {entries.filter((e) => e.state === "removed").map((entry) => <div key={entry.id}
      className="mt-3 rounded border border-amber-500 p-2" data-testid={`removed-shift-${entry.id}`}>
      <p>{entry.externalId} · {entry.sourcePosition} · {entry.date} · {time(entry.startAt)}–{time(entry.endAt)}</p>
      <p className="text-sm">{entry.currentSource
        ? `${entry.savedMinutes!==undefined?`${entry.savedMinutes} minutos`:`${entry.savedCells} posiciones`} guardadas para revisar. Si una importación rechaza un cambio ambiguo, restaura sin posiciones antes de importar y revisa el turno nuevo.`
        : "La fuente ya no contiene este turno. Puedes liberar su bloqueo para importar un nuevo turno visible, o esperar una reaparición exacta."}</p>
      <History events={entry.events} />
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={readonly || busy || !entry.currentSource}
          onClick={() => { begin({ action: "restore", entry, positions: "replay" }); setReason(""); setFeedback(""); }}>
          Restaurar con posiciones
        </button>
        <button type="button" disabled={readonly || busy || !entry.currentSource}
          onClick={() => { begin({ action: "restore", entry, positions: "none" }); setReason(""); setFeedback(""); }}>
          Restaurar sin posiciones
        </button>
        {!entry.currentSource && <button type="button" disabled={readonly || busy}
          onClick={() => { begin({ action: "resolve", entry }); setReason(""); setFeedback(""); }}>
          Liberar para nueva importación
        </button>}
      </div>
    </div>)}
    {entries.filter((e) => e.state === "resolved").map((entry) => <div key={entry.id}
      className="mt-2 rounded border p-2" data-testid={`resolved-shift-${entry.id}`}>
      <p>Bloqueo liberado · {entry.externalId} · {entry.date} · v{entry.revision}</p>
      <History events={entry.events} />
    </div>)}
    {pending && <div className="mt-3 rounded border-2 border-amber-600 p-3" data-testid="shift-removal-confirm">
      <p className="font-bold">{pending.action === "remove"
        ? `Quitar solo este turno; se liberarán ${pending.futureMinutes!==undefined?`${pending.futureMinutes} minutos futuros`:`${pending.futureCount} posiciones futuras`}.`
        : pending.action === "restore"
          ? pending.positions === "replay" ? `Restaurar este turno y validar ${pending.entry.savedMinutes!==undefined?`${pending.entry.savedMinutes} minutos`:`${pending.entry.savedCells} posiciones`} guardadas.`
            : "Restaurar solo el turno; las posiciones se volverán a pintar."
          : "Liberar este bloqueo histórico: el próximo horario importado podrá mostrar un turno nuevo. Revisa ese turno y quítalo de nuevo si hace falta."}</p>
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
    </>}
  </section>;
}
