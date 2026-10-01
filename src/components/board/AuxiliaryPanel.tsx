"use client";

import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/i18n";
import { formatShiftWindowLabel } from "@/lib/schedule/build-schedule";
import type { AuxiliaryShiftDto } from "./types";

export const AUXILIARY_IDLE_MS = 20_000;

/** Read-only schedule rows, separate from paint, board staffing and BREAK rights. */
export function AuxiliaryPanel({ shifts, locale }: { shifts: readonly AuxiliaryShiftDto[]; locale: Locale }) {
  const [open, setOpen] = useState(true);
  const panel = useRef<HTMLElement>(null);
  const lastUse = useRef(0);
  const pointerHeld = useRef(false);
  const touch = () => { lastUse.current = Date.now(); };
  useEffect(() => {
    lastUse.current = Date.now();
    const timer = window.setInterval(() => {
      if (!open || pointerHeld.current || panel.current?.contains(document.activeElement)) return;
      if (Date.now() - lastUse.current >= AUXILIARY_IDLE_MS) setOpen(false);
    }, 250);
    const release = () => { if (pointerHeld.current) lastUse.current = Date.now(); pointerHeld.current = false; };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [open]);
  const people = new Set(shifts.map(shift => shift.employee.id)).size;
  const title = locale === "es" ? "REFUERZOS" : "BACKUP";
  return <section ref={panel} className="rounded-lg border-2 border-neutral-700 bg-white p-3 text-neutral-950" data-testid="auxiliary-panel"
    onPointerDownCapture={() => { pointerHeld.current = true; touch(); }} onPointerMoveCapture={touch}
    onKeyDownCapture={touch} onFocusCapture={touch} onBlurCapture={touch} onScrollCapture={touch}>
    <button type="button" className="touch-target flex w-full items-center justify-between gap-3 rounded px-2 text-left font-bold"
      aria-expanded={open} aria-controls="auxiliary-rows" data-testid="auxiliary-toggle" onClick={() => { touch(); setOpen(value => !value); }}>
      <span>{title} · {people}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    {open && <div id="auxiliary-rows" data-testid="auxiliary-rows" className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {shifts.length === 0 && <p className="px-2 text-sm">{locale === "es" ? "Sin refuerzos programados." : "No backup scheduled."}</p>}
      {shifts.map(shift => <div key={shift.id} className="rounded border border-neutral-300 px-3 py-2" data-testid={`auxiliary-${shift.id}`}>
        <p className="font-bold">{shift.employee.firstName} {shift.employee.lastName}</p>
        <p className="text-sm">{shift.sourcePosition}</p>
        <p className="text-sm font-semibold tabular-nums">{formatShiftWindowLabel(shift.startAt, shift.endAt)}</p>
      </div>)}
    </div>}
  </section>;
}
