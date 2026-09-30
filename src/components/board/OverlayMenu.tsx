"use client";

import { useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { isDefaultMandatory } from "@/lib/mandatory";
import { quarterBounds, resolveOverlayWindow, type OverlayWindowMode } from "@/lib/overlays/windows";
import { TIMEZONE } from "@/lib/constants";
import { slicesForDay } from "./day-slice-input";
import type { DayBoardDto, ShiftDto } from "./types";

type Kind = "switch" | "remove" | "add";

const copy = {
  es: {
    menu: "Menú",
    switch: "Cambiar",
    remove: "Quitar",
    add: "Agregar",
    whole: "Todo el turno",
    rest: "Resto del turno",
    quarters: "Cuartos",
    partner: "Con",
    station: "Puesto",
    save: "Listo",
    cancel: "Cancelar",
    warn: "Esa posición obligatoria queda vacía. ¿Quitar de todos modos?",
    yes: "Quitar",
    unfit: "Esa persona no puede ese puesto.",
    refused: "No se pudo guardar.",
    close: "Cerrar",
  },
  en: {
    menu: "Menu",
    switch: "Switch",
    remove: "Remove",
    add: "Add",
    whole: "Whole shift",
    rest: "Rest of shift",
    quarters: "Chosen quarters",
    partner: "With",
    station: "Position",
    save: "Done",
    cancel: "Cancel",
    warn: "This star seat will be empty. Remove anyway?",
    yes: "Remove",
    unfit: "That person cannot do that seat.",
    refused: "Could not save.",
    close: "Close",
  },
} as const;

function label(instant: Date): string {
  return formatInTimeZone(instant, TIMEZONE, "h:mm a");
}

export function OverlayMenu({
  day,
  shift,
  board,
  date,
  locale,
  managerToken,
  readonly,
  busy,
  onSaved,
}: {
  day: DayBoardDto;
  shift: ShiftDto;
  board: "caja" | "cocina";
  date: string;
  locale: "es" | "en";
  managerToken: string;
  readonly: boolean;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const text = copy[locale];
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("remove");
  const [windowMode, setWindowMode] = useState<OverlayWindowMode>("whole");
  const [partnerId, setPartnerId] = useState("");
  const [stationId, setStationId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [warn, setWarn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const now = useMemo(() => new Date(), [open]);
  const bounds = useMemo(
    () => quarterBounds(date, new Date(shift.startAt), new Date(shift.endAt)),
    [date, shift.startAt, shift.endAt],
  );
  const slices = useMemo(() => slicesForDay(day, now), [day, now]);
  if (!day.overlayMenu || readonly) return null;

  const stars = new Set([
    ...(day.mandatory?.stationIds ?? []),
  ]);
  const people = day.shifts.filter((row) => {
    if (row.employee.id === shift.employee.id || row.supersededAt) return false;
    return !slices.slices.some((slice) => {
      const station = slice.people.find((person) => person.employeeId === row.employee.id)?.stationId;
      return station != null && (stars.has(station) || isDefaultMandatory(station));
    });
  });

  function chosenWindow() {
    return resolveOverlayWindow({
      mode: windowMode,
      date,
      shiftStart: new Date(shift.startAt),
      shiftEnd: new Date(shift.endAt),
      now,
      quarterStart: startAt ? new Date(startAt) : null,
      quarterEnd: endAt ? new Date(endAt) : null,
    });
  }

  function seatIsStar(): boolean {
    const window = chosenWindow();
    if (!window) return false;
    const inside = slices.slices.filter((slice) => {
      return slice.start.getTime() >= window.startAt.getTime() && slice.end.getTime() <= window.endAt.getTime();
    });
    const stations = new Set(inside.flatMap((slice) => {
      const station = slice.people.find((person) => person.employeeId === shift.employee.id)?.stationId;
      return station ? [station] : [];
    }));
    for (const station of stations) {
      if (stars.has(station) || isDefaultMandatory(station)) return true;
    }
    return false;
  }

  async function send() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/boards/${board}/days/${date}/overlays`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...managerAuthHeaders(managerToken) },
        body: JSON.stringify({
          kind,
          employeeId: shift.employee.id,
          partnerEmployeeId: kind === "switch" ? partnerId : null,
          stationId: kind === "add" ? stationId : null,
          window: windowMode,
          startAt: windowMode === "quarters" ? startAt : null,
          endAt: windowMode === "quarters" ? endAt : null,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error === "UNFIT" || body.error === "STAR_OTHER" ? text.unfit : text.refused);
        setWarn(false);
        return;
      }
      setOpen(false);
      setWarn(false);
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="touch-target mt-1 min-h-11 rounded-md border-2 border-neutral-900 px-2 text-xs font-bold"
        data-testid={`overlay-menu-${shift.employee.id}`}
        disabled={busy || saving}
        onClick={() => { setOpen(true); setError(null); setWarn(false); }}
      >
        {text.menu}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" data-testid="overlay-dialog">
          <div className="w-full max-w-sm rounded-lg border-2 border-neutral-900 bg-white p-4">
            <div className="flex flex-wrap gap-2">
              {(["switch", "remove", "add"] as const).map((item) => (
                <button key={item} type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-2 text-sm font-bold" aria-pressed={kind === item} data-testid={`overlay-action-${item}`} onClick={() => setKind(item)}>{text[item]}</button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["whole", "rest", "quarters"] as const).map((item) => (
                <button key={item} type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-2 text-sm font-bold" aria-pressed={windowMode === item} data-testid={`overlay-window-${item}`} onClick={() => setWindowMode(item)}>{text[item]}</button>
              ))}
            </div>
            {kind === "switch" && (
              <label className="mt-3 block text-sm font-bold">{text.partner}
                <select className="touch-target mt-1 min-h-11 w-full rounded-md border-2 border-neutral-900 px-2" value={partnerId} data-testid="overlay-partner" onChange={(event) => setPartnerId(event.target.value)}>
                  <option value="">—</option>
                  {people.map((person) => (
                    <option key={person.id} value={person.employee.id}>{person.employee.firstName}</option>
                  ))}
                </select>
              </label>
            )}
            {kind === "add" && (
              <label className="mt-3 block text-sm font-bold">{text.station}
                <select className="touch-target mt-1 min-h-11 w-full rounded-md border-2 border-neutral-900 px-2" value={stationId} data-testid="overlay-station" onChange={(event) => setStationId(event.target.value)}>
                  <option value="">—</option>
                  {day.stations.map((station) => (
                    <option key={station.id} value={station.id}>{station.label}</option>
                  ))}
                </select>
              </label>
            )}
            {windowMode === "quarters" && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <select className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-2" value={startAt} data-testid="overlay-quarter-start" onChange={(event) => setStartAt(event.target.value)}>
                  <option value="">—</option>
                  {bounds.map((bound) => <option key={bound.toISOString()} value={bound.toISOString()}>{label(bound)}</option>)}
                </select>
                <select className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-2" value={endAt} data-testid="overlay-quarter-end" onChange={(event) => setEndAt(event.target.value)}>
                  <option value="">—</option>
                  {bounds.map((bound) => <option key={`end-${bound.toISOString()}`} value={bound.toISOString()}>{label(bound)}</option>)}
                </select>
              </div>
            )}
            {error && <p className="mt-3 text-sm font-bold text-red-800" role="alert" data-testid="overlay-error">{error}</p>}
            {warn && <p className="mt-3 text-sm font-bold" data-testid="overlay-star-warn">{text.warn}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 px-3 font-bold" onClick={() => { setOpen(false); setWarn(false); }}>{text.close}</button>
              {warn ? (
                <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 bg-neutral-900 px-3 font-bold text-white" data-testid="overlay-star-confirm" disabled={saving} onClick={() => { void send(); }}>{text.yes}</button>
              ) : (
                <button type="button" className="touch-target min-h-11 rounded-md border-2 border-neutral-900 bg-neutral-900 px-3 font-bold text-white" data-testid="overlay-save" disabled={saving} onClick={() => {
                  if (kind === "remove" && seatIsStar()) { setWarn(true); return; }
                  void send();
                }}>{text.save}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
