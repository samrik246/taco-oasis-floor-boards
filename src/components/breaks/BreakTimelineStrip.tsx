"use client";

import { useEffect, useState } from "react";
import type { Locale } from "@/lib/i18n";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { breakRange, stateLabel, statusClass, type BreakTimeline } from "@/lib/breaks/display";

export function TimelineChips({ data, locale, grouped = false }: { data: BreakTimeline; locale: Locale; grouped?: boolean }) {
  const rows = [...data.breaks].sort((a, b) => Number(b.state === "pending") - Number(a.state === "pending") || a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
  if (grouped) return <div className="space-y-3" data-testid="break-grouped-requests">
    {(["cocina", "caja"] as const).map(board => <section key={board} data-testid={`break-group-${board}`}>
      <h2 className="mb-2 text-lg font-black">{board === "cocina" ? "Cocina" : "Caja"} · {rows.filter(row => row.board === board).length}</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.filter(row => row.board === board).map(row => <article key={row.id} className={`min-w-0 rounded-xl border-2 px-3 py-2 [overflow-wrap:anywhere] ${statusClass[row.state]}`} data-state={row.state} data-testid="break-chip">
          <p className="font-bold">{row.firstName}</p>
          <p className="text-sm">{breakRange(row)}</p>
          <p className="text-sm font-bold">{stateLabel(locale, row.state)}</p>
        </article>)}
      </div>
      {!rows.some(row => row.board === board) && <p className="text-sm">{locale === "es" ? "Sin BREAK registrados" : "No BREAK requests"}</p>}
    </section>)}
    {!data.gerenteAvailable && <p className="text-sm font-bold">{locale === "es" ? "Sin gerente habilitado ahora" : "No authorized gerente now"}</p>}
  </div>;
  return <>
    <p className="text-sm font-semibold">{locale === "es" ? "Caja + Cocina · Desliza para ver todos" : "Caja + Cocina · Scroll to see all"} · {rows.length}</p>
    <div className="flex gap-2 overflow-x-auto pb-3" tabIndex={0} role="region" aria-label="BREAK Caja + Cocina" data-testid="break-timeline-chips">
      {rows.map(row => <article key={row.id} className={`min-w-56 shrink-0 rounded-xl border-2 p-3 ${statusClass[row.state]}`} data-state={row.state} data-testid="break-chip">
        <p className="font-bold">{row.firstName} · {row.board === "caja" ? "Caja" : "Cocina"}</p>
        <p>{breakRange(row)}</p><p className="font-bold">{stateLabel(locale, row.state)}</p>
        {row.state === "pending" && <p className="text-sm">{locale === "es" ? "Visible para el gerente." : "Visible to the gerente."}</p>}
      </article>)}
      {!rows.length && <p>{locale === "es" ? "Sin BREAK registrados" : "No BREAK requests"}</p>}
    </div>
    {!data.gerenteAvailable && <p className="text-sm font-bold">{locale === "es" ? "Sin gerente habilitado ahora" : "No authorized gerente now"}</p>}
  </>;
}

export function BreakTimelineStrip({ locale, date, managerToken, refreshKey }: { locale: Locale; date?: string; managerToken?: string; refreshKey?: string }) {
  const [snapshot, setSnapshot] = useState<{ key: string; data: BreakTimeline } | null>(null);
  const [failed, setFailed] = useState(false);
  const key = `${date ?? "today"}:${managerToken ?? "staff"}:${refreshKey ?? ""}`;
  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    async function pull() {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/breaks/timeline${date ? `?date=${encodeURIComponent(date)}` : ""}`, { cache: "no-store", headers: managerAuthHeaders(managerToken), signal: controller.signal });
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json() as BreakTimeline;
        if (alive) { setSnapshot({ key, data }); setFailed(false); }
      } catch (error) {
        if (alive && !(error instanceof Error && error.name === "AbortError")) { setSnapshot(null); setFailed(true); }
      }
    }
    void pull();
    const timer = window.setInterval(pull, 15_000);
    window.addEventListener("focus", pull);
    return () => { alive = false; controller?.abort(); window.clearInterval(timer); window.removeEventListener("focus", pull); };
  }, [key, date, managerToken]);
  return <section className="border-b-2 border-neutral-300 bg-white px-4 py-3" data-testid="break-strip" aria-label="BREAK">
    <h2 className="font-black">BREAK</h2>
    {snapshot?.key === key && <TimelineChips data={snapshot.data} locale={locale} />}
    {failed && <p role="status">{locale === "es" ? "No se pudo actualizar BREAK" : "Could not refresh BREAK"}</p>}
  </section>;
}
