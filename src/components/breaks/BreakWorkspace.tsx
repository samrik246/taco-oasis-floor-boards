"use client";

import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/constants";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/i18n";
import { useManagerIdle } from "@/components/board/useManagerSession";
import { STAFF_SESSION_HEADER } from "@/lib/breaks/header";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { breakLengthMinutes, breakQuarterFaces, preferredBreakLength } from "@/lib/breaks/picker-steps";
import { approvalLine, unavailableLabel, breakButton, breakClock, breakRange, stateLabel, statusClass, type BreakArea, type BreakOption, type BreakStatus, type BreakTimeline, type BreakWindow } from "@/lib/breaks/display";
import { TimelineChips } from "./BreakTimelineStrip";
import { ManagerBreakDialog } from "./ManagerBreakDialog";
import { ManagerPairingPanel } from "./ManagerPairingPanel";

export const BREAK_SAVED_MS = 10_000;
export const BREAK_IDLE_MS = 60_000;
export const BREAK_KEYPAD_IDLE_MS = 30_000;
type Phase = "keypad" | "picker" | "saved" | "queue" | "pairing";
type Session = { token: string; kind: "staff" | "gerente"; staffToken?: string; name: string; role?: string; idleMs?: number };
type Mine = { name: string; allowanceMinutes: number; shifts: (BreakWindow & { board: BreakArea })[]; blocked: (BreakWindow & { reason: "blackout" | "overlap" })[]; slots: BreakOption[]; saved: BreakStatus | null };
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

export function BreakWorkspace({ board, locale, onClose }: { board: BreakArea; locale: Locale; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("keypad");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [timeline, setTimeline] = useState<BreakTimeline | null>(null);
  const [date, setDate] = useState("");
  const [chosenStart, setChosenStart] = useState<string | null>(null);
  const [chosenEnd, setChosenEnd] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [managed, setManaged] = useState<{ employeeId: string; name: string; board: BreakArea } | null>(null);
  const generation = useRef(0);
  const mineRequest = useRef(0);
  const refreshRequest = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const es = locale === "es";
  const staffToken = session?.kind === "staff" ? session.token : session?.staffToken;
  const reset = useCallback(() => {
    generation.current += 1;
    setSession(null); setMine(null); setTimeline(null); setManaged(null); setDate(""); setCode("");
    setChosenStart(null); setChosenEnd(null); setPhase("keypad"); setBusy(false);
  }, []);
  const close = useCallback(() => { reset(); onClose(); }, [reset, onClose]);
  const denied = useCallback(() => { reset(); setMessage(es ? "Entra otra vez. Se revisará tu acceso actual." : "Sign in again to check current access."); }, [reset, es]);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => { if (phase === "keypad") inputRef.current?.focus(); }, [phase]);
  useManagerIdle({ active: !paused && phase !== "saved", idleMs: !session ? BREAK_KEYPAD_IDLE_MS : session.kind === "gerente" ? session.idleMs ?? 15_000 : BREAK_IDLE_MS, onIdle: close });
  useEffect(() => {
    if (phase !== "saved") return;
    const timer = window.setTimeout(close, BREAK_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [phase, close]);
  useEffect(() => {
    if (!paused) return;
    const timer = window.setTimeout(() => { setPaused(false); setMessage(es ? "Ya puedes intentar" : "You can try again"); }, 60_000);
    return () => window.clearTimeout(timer);
  }, [paused, es]);

  const loadMine = useCallback(async (token: string, version: number) => {
    const request = ++mineRequest.current;
    const response = await fetch("/api/breaks/mine", { cache: "no-store", headers: { [STAFF_SESSION_HEADER]: token } });
    if (version !== generation.current || request !== mineRequest.current) return null;
    if (response.status === 401 || response.status === 403) { denied(); return null; }
    if (!response.ok) throw new Error("mine");
    const data = await response.json() as Mine;
    if (version !== generation.current || request !== mineRequest.current) return null;
    setMine(data); return data;
  }, [denied]);

  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    const version = generation.current;
    try {
      if (session?.kind === "gerente") {
        const check = await fetch("/api/breaks/session", { cache: "no-store", headers: managerAuthHeaders(session.token) });
        if (version !== generation.current || request !== refreshRequest.current) return;
        if (check.status === 401 || check.status === 403) { denied(); return; }
        if (!check.ok) throw new Error("access");
        const current = await check.json() as { role: string };
        if (version !== generation.current || request !== refreshRequest.current) return;
        if (current.role !== session.role) { denied(); return; }
      }
      const response = await fetch(`/api/breaks/timeline${date ? `?date=${encodeURIComponent(date)}` : ""}`, { cache: "no-store", headers: managerAuthHeaders(session?.kind === "gerente" ? session.token : null) });
      if (version !== generation.current || request !== refreshRequest.current) return;
      if (response.status === 401 || response.status === 403) { denied(); return; }
      if (!response.ok) throw new Error("timeline");
      const data = await response.json() as BreakTimeline;
      if (version !== generation.current || request !== refreshRequest.current) return;
      setTimeline(data);
      if (staffToken && (phase === "picker" || phase === "saved")) await loadMine(staffToken, version);
    } catch {
      if (version === generation.current && request === refreshRequest.current) { setTimeline(null); setMessage(es ? "No se pudo actualizar. Intenta otra vez." : "Could not refresh. Try again."); }
    }
  }, [session, date, staffToken, phase, denied, loadMine, es]);
  useEffect(() => {
    const kick = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(refresh, 15_000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => { window.clearTimeout(kick); window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);

  async function signIn(value: string) {
    if (busy || paused || value.trim().length < 4) return;
    setBusy(true); setMessage("");
    const version = ++generation.current;
    try {
      const response = await fetch("/api/breaks/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board, code: value }) });
      const body = await response.json() as Session & { error?: string };
      if (version !== generation.current) return;
      setCode("");
      if (response.status === 423) { setPaused(true); setMessage(es ? "Espera 1 minuto" : "Wait 1 minute"); return; }
      if (!response.ok || !body.token) { setMessage(body.error ?? (es ? "Ese código no coincide." : "Code not recognized.")); return; }
      setSession(body);
      if (body.kind === "gerente") setPhase("queue");
      else { setPhase("picker"); await loadMine(body.token, version); }
    } catch { if (version === generation.current) setMessage(es ? "No se pudo entrar. Intenta otra vez." : "Could not sign in. Try again."); }
    finally { if (version === generation.current) setBusy(false); }
  }
  function press(key: string) {
    if (paused || busy) return;
    if (key === "⌫") { setCode(v => v.slice(0, -1)); return; }
    if (!key || code.length >= 64) return;
    setCode(code + key);
  }
  async function save(slot: BreakOption) {
    if (!staffToken || busy) return;
    setBusy(true); setMessage(""); const version = generation.current;
    try {
      const response = await fetch("/api/breaks/mine", { method: "POST", headers: { "content-type": "application/json", [STAFF_SESSION_HEADER]: staffToken }, body: JSON.stringify({ startAt: slot.startAt, endAt: slot.endAt }) });
      const result = await response.json() as { error?: string };
      if (version !== generation.current) return;
      if (response.status === 401 || response.status === 403) { denied(); return; }
      if (!response.ok) { setMessage(result.error ?? (es ? "Elige otro horario." : "Choose another time.")); await loadMine(staffToken, version); return; }
      // Re-read the persisted pending/booked result, never infer approval from the old preview.
      if (await loadMine(staffToken, version)) { setPhase("saved"); setChosenStart(null); setChosenEnd(null); }
    } catch { if (version === generation.current) setMessage(es ? "No se pudo confirmar. Actualiza antes de intentar otra vez." : "Could not confirm. Refresh before trying again."); }
    finally { if (version === generation.current) setBusy(false); }
  }
  async function clear() {
    if (!staffToken || busy) return;
    setBusy(true); const version = generation.current;
    try {
      const response = await fetch("/api/breaks/mine", { method: "DELETE", headers: { [STAFF_SESSION_HEADER]: staffToken } });
      if (version !== generation.current) return;
      if (response.status === 401 || response.status === 403) { denied(); return; }
      if (!response.ok) throw new Error("clear");
      close();
    } catch { if (version === generation.current) setMessage(es ? "No se pudo quitar." : "Could not cancel."); }
    finally { if (version === generation.current) setBusy(false); }
  }
  function back() {
    setMessage("");
    if (phase === "pairing") { setPhase("queue"); return; }
    if (phase === "saved") { setPhase("picker"); return; }
    if (chosenStart) { setChosenStart(null); setChosenEnd(null); return; }
    if (phase === "picker" && session?.kind === "gerente") { setPhase("queue"); return; }
    if (phase !== "keypad") { reset(); return; }
    close();
  }
  const lengths = mine?.slots.filter(s => s.startAt === chosenStart) ?? [];
  const selected = (lengths.find(s => s.endAt === chosenEnd) ?? preferredBreakLength(lengths, mine?.allowanceMinutes ?? 0)) as BreakOption | null;
  const faces = mine ? breakQuarterFaces({ shifts: mine.shifts, slots: mine.slots, blocked: mine.blocked }) : [];
  const historical = !!date && !!timeline && date !== formatInTimeZone(new Date(timeline.asOf), TIMEZONE, "yyyy-MM-dd");

  return <section className="flex min-h-full w-full flex-col gap-5 bg-white p-4 text-neutral-950 sm:p-6" data-testid="break-home" data-phase={phase} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); if (managed) setManaged(null); else back(); }
    if (event.key === "Tab") {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header className="sticky top-0 z-20 bg-white flex flex-wrap items-center gap-3 border-b-2 pb-3">
      <h1 className="mr-auto text-3xl font-black">BREAK{session?.kind === "gerente" ? " · Gerente" : ""}</h1>
      {session && <button className={breakButton} disabled={busy} onClick={() => void refresh()} data-testid="break-refresh">{es ? "Actualizar" : "Refresh"}</button>}
      <button className={breakButton} onClick={back} disabled={busy} data-testid="break-back">{es ? "Atrás" : "Back"}</button>
      <button className={breakButton} onClick={close} data-testid="break-close">{es ? "Cerrar · Volver al tablero" : "Close · Back to board"}</button>
    </header>
    {message && <p className="rounded-xl border-2 border-amber-700 bg-amber-50 p-3 font-bold" role="alert" data-testid="break-message">{message}</p>}
    {phase === "keypad" && <div className="grid gap-6 lg:grid-cols-2" data-testid="break-keypad">
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void signIn(code); }}>
        <h2 className="text-2xl font-bold">{es ? "Entra con tu código" : "Enter your code"}</h2>
        <label className="block font-bold" htmlFor="break-code">{es ? "Código" : "Code"}</label>
        <input ref={inputRef} id="break-code" type="password" inputMode="text" autoComplete="off" maxLength={64} className="min-h-16 w-full rounded-xl border-2 px-4 text-3xl tracking-widest" value={code} disabled={busy || paused} onChange={e => setCode(e.target.value)} data-testid="break-code-input" />
        <div className="grid grid-cols-3 gap-2">{KEYS.map(key => <button key={key || "blank"} type="button" className={`${breakButton} min-h-16 text-2xl`} disabled={busy || paused || !key} data-testid={key === "⌫" ? "break-key-back" : key ? `break-key-${key}` : undefined} onClick={() => press(key)}>{key}</button>)}</div>
        <button className={`${breakButton} w-full bg-neutral-950 text-white active:bg-neutral-700`} disabled={busy || paused || code.length < 4} data-testid="break-sign-in">{es ? "Entrar" : "Sign in"}</button>
      </form>
      <div className="min-w-0 space-y-3" data-testid="break-entry-requests">{timeline && <TimelineChips data={timeline} locale={locale} grouped />}</div>
    </div>}
    {(phase === "picker" || phase === "saved") && mine && <section className="space-y-5" data-testid={phase === "saved" ? "break-saved" : "break-worker"}>
      <h2 className="text-3xl font-bold" data-testid="break-name">{mine.name}</h2>
      <p className="text-xl" data-testid="break-shift">{mine.shifts.map(s => `${s.board === "caja" ? "Caja" : "Cocina"}: ${breakRange(s)}`).join(" · ")}. {es ? `Te tocan máximo ${mine.allowanceMinutes} minutos` : `You get up to ${mine.allowanceMinutes} minutes`}</p>
      <article className={`rounded-2xl border-2 p-5 ${mine.saved ? statusClass[mine.saved.state] : "border-neutral-300"}`} data-testid="break-status">
        <h3 className="text-2xl font-black" data-testid="break-saved-title">{stateLabel(locale, mine.saved?.state ?? "absent")}</h3>
        {mine.saved && <><p className="text-xl" data-testid="break-current">{mine.saved.board === "caja" ? "Caja" : "Cocina"} · {breakRange(mine.saved)}</p>
          {mine.saved.approval && <p className="font-bold">{approvalLine(locale, mine.saved.approval)}</p>}
          {mine.saved.state === "pending" && <><p>{es ? "Visible para el gerente." : "Visible to the gerente."}</p><p className="text-xl font-bold">{es ? "Espera la aprobación antes de salir a tu BREAK." : "Wait for approval before starting your BREAK."}</p><p>{es ? "En los cinco minutos previos se intentará resolver. Puede posponerse 15 minutos o finalizar la solicitud." : "Resolution is attempted in the five-minute window. It may move 15 minutes later or end without approval."}</p></>}
          {mine.saved.state === "reserved" && <p>{es ? "Tu BREAK está reservado. Revisa el estado antes de salir." : "Your BREAK is reserved. Check its status before leaving."}</p>}
          {mine.saved.state === "on-break" && <p>{es ? "Regresa al terminar este horario." : "Return at the end of this time."}</p>}
          {mine.saved.state === "completed" && <p>{es ? "Tu BREAK terminó." : "Your BREAK has finished."}</p>}
          {mine.saved.state === "ended" && <p>{es ? "Esta solicitud no fue aprobada. Elige otro horario disponible." : "This request was not approved. Choose another available time."}</p>}
        </>}
        {!mine.saved && <p>{es ? "Elige un horario y toca RESERVAR." : "Choose a time and tap RESERVE."}</p>}
      </article>
      {phase === "picker" && <>
        {!chosenStart && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="break-starts">{faces.map(face => {
          const option = preferredBreakLength(mine.slots.filter(s => s.startAt === face.startAt), mine.allowanceMinutes) as BreakOption | null;
          return <button key={face.startAt} className={`${breakButton} min-h-24 text-left`} data-testid="break-start" data-start={face.startAt} data-reason={face.reason ?? ""} disabled={busy || face.disabled} onClick={() => { setChosenStart(face.startAt); setChosenEnd(null); }}><span className="block text-xl">{breakClock(face.startAt)}</span><span className="block text-sm">{option ? `${option.board === "caja" ? "Caja" : "Cocina"} · ${approvalLine(locale, option.approval, true)}` : face.reason ? unavailableLabel(locale) : ""}</span></button>;
        })}</div>}
        {selected && <div className="space-y-4"><button className={breakButton} disabled={busy} onClick={() => { setChosenStart(null); setChosenEnd(null); }} data-testid="break-start-back">{es ? "Otro inicio" : "Different start"}</button>
          <p className="text-xl font-bold">{selected.board === "caja" ? "Caja" : "Cocina"} · {breakRange(selected)}</p><p>{approvalLine(locale, selected.approval, true)}</p>
          <div className="grid grid-cols-3 gap-3">{lengths.map(slot => <button key={slot.endAt} className={`${breakButton} ${selected.endAt === slot.endAt ? "bg-blue-100" : ""}`} disabled={busy} aria-pressed={selected.endAt === slot.endAt} onClick={() => setChosenEnd(slot.endAt)} data-testid="break-slot" data-start={slot.startAt} data-end={slot.endAt}>{breakLengthMinutes(slot)} min<span className="block text-sm">{approvalLine(locale, slot.approval)}</span></button>)}</div>
          <button className={`${breakButton} min-h-20 w-full bg-neutral-950 text-2xl text-white active:bg-neutral-700`} disabled={busy} onClick={() => void save(selected)} data-testid="break-save" data-start={selected.startAt} data-end={selected.endAt}>{es ? "RESERVAR" : "RESERVE"}<span className="block text-lg">{breakRange(selected)}, {breakLengthMinutes(selected)} min</span></button>
        </div>}
        {!faces.length && <p>{es ? "No hay horarios disponibles." : "No available times."}</p>}
      </>}
      {mine.saved && <button className={breakButton} disabled={busy} onClick={() => void clear()} data-testid={phase === "saved" ? "break-saved-clear" : "break-clear"}>{es ? "Quitar BREAK" : "Cancel BREAK"}</button>}
    </section>}
    {phase === "queue" && session?.kind === "gerente" && <section className="space-y-4" data-testid="break-gerente">
      <h2 className="text-2xl font-bold">{session.name} · Gerente</h2>
      <div className="flex flex-wrap gap-3">
        {staffToken && <button className={breakButton} onClick={() => { setDate(""); setPhase("picker"); }} data-testid="break-own">{es ? "Mi BREAK · RESERVAR" : "My BREAK · RESERVE"}</button>}
        {session.role === "owner" && <><button className={breakButton} onClick={() => setPhase("pairing")} data-testid="break-pairing-open">{es ? "Vincular gerentes" : "Pair gerentes"}</button><label>{es ? "Consultar fecha" : "View date"}<input className={`${breakButton} ml-2`} type="date" value={date || timeline?.date || ""} onChange={e => { generation.current += 1; setTimeline(null); setDate(e.target.value); }} data-testid="break-date" /></label><button className={breakButton} onClick={() => { generation.current += 1; setDate(""); setTimeline(null); }}>{es ? "Hoy" : "Today"}</button></>}
      </div>
      {timeline && <><TimelineChips data={timeline} locale={locale} grouped /><h3 className="text-xl font-bold">{es ? "Solicitudes pendientes" : "Pending requests"}</h3>
        {timeline.breaks.filter(row => row.state === "pending").sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id)).map(row => <div className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-amber-700 bg-amber-50 p-4" key={row.id}><span className="mr-auto font-bold">{row.firstName} · {row.board} · {breakRange(row)}</span>{!historical && <button className={breakButton} onClick={() => setManaged({ employeeId: row.employeeId, name: row.firstName, board: row.board })} data-testid="break-review">{es ? "Revisar" : "Review"}</button>}</div>)}
        {!timeline.breaks.some(row => row.state === "pending") && <p>{es ? "Sin solicitudes pendientes" : "No pending requests"}</p>}
        {historical ? <p>{es ? "Solo consulta. Los cambios de BREAK son para hoy." : "Read only. BREAK changes are today only."}</p> : <><h3 className="text-xl font-bold">{es ? "Personas de hoy" : "Today's people"}</h3><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{timeline.people.map(person => <div key={person.id} className="rounded-xl border-2 p-3"><p className="font-bold">{person.name}</p>{[...new Set(person.shifts.map(s => s.board))].map(area => <button key={area} className={`${breakButton} mr-2 mt-2`} onClick={() => setManaged({ employeeId: person.id, name: person.name, board: area })}>{area === "caja" ? "Caja" : "Cocina"} · BREAK</button>)}</div>)}</div></>}
      </>}
    </section>}
    {phase === "pairing" && session?.role === "owner" && <ManagerPairingPanel token={session.token} locale={locale} onDenied={denied} />}
    {managed && session?.kind === "gerente" && <ManagerBreakDialog {...managed} managerToken={session.token} locale={locale} onDenied={denied} onClose={() => setManaged(null)} onExit={close} onSaved={refresh} />}
  </section>;
}
