"use client";
import { useCallback, useEffect, useState } from "react";
import type { Locale } from "@/lib/i18n";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { breakButton } from "@/lib/breaks/display";

type PairingData = {
  from: string; through: string; incompleteHistory: boolean;
  managers: { id: string; name: string; employeeId: string | null; role: string; active: boolean }[];
  people: { id: string; name: string; positions: string[] }[];
};
export function ManagerPairingPanel({ token, locale, onDenied }: { token: string; locale: Locale; onDenied: () => void }) {
  const [data, setData] = useState<PairingData | null>(null);
  const [choice, setChoice] = useState<{ managerId: string; employeeId: string } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/admin/manager-pairings", { headers: managerAuthHeaders(token), cache: "no-store", signal });
    if (response.status === 401 || response.status === 403) { onDenied(); return; }
    if (!response.ok) throw new Error("pairing");
    const next = await response.json() as PairingData;
    if (!signal?.aborted) setData(next);
  }, [token, onDenied]);
  useEffect(() => {
    const controller = new AbortController();
    const kick = window.setTimeout(() => void load(controller.signal).catch(() => { if (!controller.signal.aborted) setMessage(locale === "es" ? "No se pudo cargar" : "Could not load"); }), 0);
    return () => { window.clearTimeout(kick); controller.abort(); };
  }, [load, locale]);
  async function confirm() {
    if (!choice || busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/manager-pairings", { method: "PUT", headers: { "content-type": "application/json", ...managerAuthHeaders(token) }, body: JSON.stringify({ ...choice, employeeId: choice.employeeId || null, confirm: true }) });
      if (response.status === 401 || response.status === 403) { onDenied(); return; }
      if (!response.ok) throw new Error("pairing");
      setChoice(null); await load();
      setMessage(locale === "es" ? "Vínculo guardado" : "Pairing saved");
    } catch { setMessage(locale === "es" ? "No se pudo guardar el vínculo" : "Could not save pairing"); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4" data-testid="manager-pairing">
    <h2 className="text-2xl font-bold">{locale === "es" ? "Vincular gerentes" : "Pair gerentes"}</h2>
    {data && <>
      <p>{data.from} – {data.through} · America/Chicago</p>
      {data.incompleteHistory && <p role="status">{locale === "es" ? "Historial retenido incompleto para estos 14 días." : "Retained history is incomplete for these 14 days."}</p>}
      <p>{locale === "es" ? "Selecciona una persona y confirma cada vínculo. El horario de hoy decide la autoridad." : "Select a person and confirm each pairing. Today's schedule determines authority."}</p>
      {data.managers.map(manager => <div key={manager.id} className="rounded-xl border-2 p-4" data-testid="pairing-row">
        <p className="font-bold">{manager.name} · {manager.employeeId ? (locale === "es" ? "Vinculado" : "Linked") : (locale === "es" ? "Sin vínculo" : "Unlinked")}{!manager.active ? (locale === "es" ? " · Inactivo" : " · Inactive") : ""}</p>
        <select className={`${breakButton} mt-2 w-full bg-white`} aria-label={`${locale === "es" ? "Persona para" : "Person for"} ${manager.name}`} value={choice?.managerId === manager.id ? choice.employeeId : manager.employeeId ?? ""} disabled={busy} onChange={e => setChoice({ managerId: manager.id, employeeId: e.target.value })}>
          <option value="">{locale === "es" ? "Sin vínculo" : "Unlinked"}</option>
          {manager.employeeId && !data.people.some(p => p.id === manager.employeeId) && <option value={manager.employeeId}>{locale === "es" ? "Vínculo actual fuera del historial" : "Current pairing outside history"}</option>}
          {data.people.map((person, index) => <option key={person.id} value={person.id}>{person.name} · {person.positions.join(", ")} · #{index + 1}</option>)}
        </select>
        {choice?.managerId === manager.id && <div className="mt-3 flex flex-wrap gap-2" data-testid="pairing-confirmation">
          <p className="w-full">{manager.name} → {data.people.find(p => p.id === choice.employeeId)?.name ?? (locale === "es" ? "Sin vínculo" : "Unlinked")}</p>
          <button className={breakButton} disabled={busy} onClick={() => void confirm()} data-testid="pairing-confirm">{locale === "es" ? "Confirmar vínculo" : "Confirm pairing"}</button>
          <button className={breakButton} disabled={busy} onClick={() => setChoice(null)}>{locale === "es" ? "Cancelar" : "Cancel"}</button>
        </div>}
      </div>)}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
