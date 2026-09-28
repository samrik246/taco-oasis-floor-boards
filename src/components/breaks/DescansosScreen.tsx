"use client";

import { useCallback, useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { useSearchParams } from "next/navigation";
import { KioskLock, kioskRequested, releaseKioskLock } from "@/components/board/KioskLock";
import { STAFF_SESSION_HEADER } from "@/lib/breaks/header";
import { BREAK_PAUSE, BREAK_PAUSE_READY } from "@/lib/breaks/messages";
import {
  boardKioskReturnHref,
  breakLengthMinutes,
  breakLengthsForStart,
  breakQuarterFaces,
  breakSaveLine,
  preferredBreakLength,
  shiftAllowanceLine,
  type BreakChoice,
} from "@/lib/breaks/picker-steps";
import { TIMEZONE } from "@/lib/constants";

export const BREAK_SAVED_MS = 10_000;
export const BREAK_IDLE_MS = 60_000;
export const BREAK_KEYPAD_IDLE_MS = 30_000;

type Phase = "home" | "keypad" | "picker" | "saved" | "expired";

type Slot = { startAt: string; endAt: string };

type Mine = {
  name: string;
  allowanceMinutes: number;
  shifts: Slot[];
  blocked: { startAt: string; endAt: string; reason: "blackout" | "overlap" }[];
  slots: Slot[];
  saved: Slot | null;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"] as const;

function clock(iso: string): string {
  return formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");
}

function rangeWords(slot: Slot): string {
  return `${clock(slot.startAt)} a ${clock(slot.endAt)}`;
}

export function DescansosScreen() {
  const params = useSearchParams();
  const kiosk = kioskRequested(params);
  const boardParam = params.get("board");
  const board = boardParam === "caja" || boardParam === "cocina" ? boardParam : null;
  const returnHref = boardKioskReturnHref(params.get("from"), board);
  const [phase, setPhase] = useState<Phase>("home");
  const [digits, setDigits] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [message, setMessage] = useState("");
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chosenStart, setChosenStart] = useState<string | null>(null);
  const [chosenEnd, setChosenEnd] = useState<string | null>(null);

  const goHome = useCallback((next: Phase = "home") => {
    setToken(null);
    setMine(null);
    setDigits("");
    setChosenStart(null);
    setChosenEnd(null);
    setPaused(false);
    setPhase(next);
  }, []);

  const leave = useCallback(() => {
    setMessage("");
    if (returnHref) {
      releaseKioskLock();
      window.location.assign(returnHref);
      return;
    }
    goHome("home");
  }, [goHome, returnHref]);

  const loadMine = useCallback(async (session: string) => {
    const response = await fetch("/api/breaks/mine", { headers: { [STAFF_SESSION_HEADER]: session } });
    if (response.status === 401) {
      setMessage("Se acabó el tiempo. Entra otra vez.");
      goHome("expired");
      return null;
    }
    if (!response.ok) {
      setMessage("No se pudo abrir tu descanso.");
      return null;
    }
    const body = await response.json() as Mine;
    setMine(body);
    return body;
  }, [goHome]);

  useEffect(() => {
    if (!token || phase === "saved" || phase === "home" || phase === "keypad" || phase === "expired") return;
    let timer = window.setTimeout(() => leave(), BREAK_IDLE_MS);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => leave(), BREAK_IDLE_MS);
    };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
    };
  }, [token, phase, leave]);

  useEffect(() => {
    if (paused || (phase !== "keypad" && phase !== "expired")) return;
    let timer = window.setTimeout(() => leave(), BREAK_KEYPAD_IDLE_MS);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => leave(), BREAK_KEYPAD_IDLE_MS);
    };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
    };
  }, [phase, paused, leave]);

  useEffect(() => {
    if (!paused) return;
    const timer = window.setTimeout(() => {
      setPaused(false);
      setMessage(BREAK_PAUSE_READY);
    }, 60_000);
    return () => window.clearTimeout(timer);
  }, [paused]);

  useEffect(() => {
    if (phase !== "saved") return;
    const timer = window.setTimeout(() => leave(), BREAK_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [phase, leave]);

  async function submitCode(code: string) {
    if (!board || busy || paused) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/breaks/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ board, code }),
      });
      const body = await response.json() as { error?: string; token?: string; name?: string };
      setDigits("");
      if (response.status === 423) {
        setPaused(true);
        setMessage(body.error ?? BREAK_PAUSE);
        return;
      }
      if (!response.ok || !body.token) {
        setMessage(body.error ?? "Ese código no coincide.");
        return;
      }
      setToken(body.token);
      setChosenStart(null);
      setChosenEnd(null);
      setPhase("picker");
      await loadMine(body.token);
    } finally {
      setBusy(false);
    }
  }

  function press(key: string) {
    if (paused || busy) return;
    if (key === "⌫") {
      setDigits((current) => current.slice(0, -1));
      return;
    }
    if (key === "" || digits.length >= 4) return;
    const next = `${digits}${key}`;
    setDigits(next);
    if (next.length === 4) void submitCode(next);
  }

  async function pick(slot: Slot) {
    if (!token || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/breaks/mine", {
        method: "POST",
        headers: { "content-type": "application/json", [STAFF_SESSION_HEADER]: token },
        body: JSON.stringify({ startAt: slot.startAt, endAt: slot.endAt }),
      });
      const body = await response.json() as { error?: string; startAt?: string; endAt?: string };
      if (response.status === 401) {
        setMessage("Se acabó el tiempo. Entra otra vez.");
        goHome("expired");
        return;
      }
      if (!response.ok || !body.startAt || !body.endAt) {
        setMessage(body.error ?? "Elige otro horario.");
        return;
      }
      setMine((current) => current ? { ...current, saved: { startAt: body.startAt!, endAt: body.endAt! } } : current);
      setPhase("saved");
    } finally {
      setBusy(false);
    }
  }

  async function clearBreak() {
    if (!token || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/breaks/mine", {
        method: "DELETE",
        headers: { [STAFF_SESSION_HEADER]: token },
      });
      if (response.status === 401) {
        setMessage("Se acabó el tiempo. Entra otra vez.");
        goHome("expired");
        return;
      }
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        setMessage(body.error ?? "No se pudo quitar.");
        return;
      }
      setMessage("");
      leave();
    } finally {
      setBusy(false);
    }
  }

  const lengths = mine && chosenStart ? breakLengthsForStart(mine.slots, chosenStart) : [];
  const selected = chosenEnd
    ? lengths.find((slot) => slot.endAt === chosenEnd) ?? preferredBreakLength(lengths, mine?.allowanceMinutes ?? 0)
    : preferredBreakLength(lengths, mine?.allowanceMinutes ?? 0);
  const showingLengths = selected != null;
  const faces = mine ? breakQuarterFaces({ shifts: mine.shifts ?? [], slots: mine.slots, blocked: mine.blocked ?? [] }) : [];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 bg-white p-6 text-neutral-950" data-testid="break-home" data-phase={phase}>
      <KioskLock active={kiosk} />
      <h1 className="text-3xl font-bold">Descansos</h1>
      {!board && <p className="text-lg font-semibold" role="alert">Esa área no tiene descansos.</p>}
      {board && phase === "home" && (
        <button
          type="button"
          className="min-h-40 rounded-2xl border-4 border-neutral-950 bg-neutral-950 text-4xl font-bold text-white"
          data-testid="break-personal"
          onClick={() => { setMessage(""); setPhase("keypad"); }}
        >
          Personal
        </button>
      )}
      {board && phase === "expired" && (
        <section className="flex flex-col gap-4">
          <button
            type="button"
            className="min-h-40 rounded-2xl border-4 border-neutral-950 bg-neutral-950 text-4xl font-bold text-white"
            data-testid="break-personal"
            onClick={() => { setMessage(""); setPhase("keypad"); }}
          >
            Personal
          </button>
          <BackHome onBack={leave} />
        </section>
      )}
      {message && <p className="rounded-md border-2 border-neutral-950 px-3 py-2 text-lg font-bold" role="alert" data-testid="break-message">{message}</p>}
      {board && phase === "keypad" && (
        <section className="flex flex-col gap-4" data-testid="break-keypad">
          <p className="text-center text-4xl tracking-[0.5em]" aria-label="dígitos">{digits.replace(/./g, "•") || " "}</p>
          <div className="grid grid-cols-3 gap-3">
            {KEYS.map((key) => (
              <button
                key={key || "blank"}
                type="button"
                className="min-h-16 rounded-xl border-2 border-neutral-950 text-3xl font-bold disabled:opacity-40"
                disabled={paused || busy || key === ""}
                data-testid={key === "⌫" ? "break-key-back" : key ? `break-key-${key}` : undefined}
                onClick={() => press(key)}
              >
                {key}
              </button>
            ))}
          </div>
          <BackHome onBack={leave} />
        </section>
      )}
      {phase === "picker" && mine && (
        <section className="flex flex-col gap-4">
          <p className="text-2xl font-bold" data-testid="break-name">{mine.name}</p>
          {mine.shifts.length > 0 && (
            <p className="text-lg font-semibold" data-testid="break-shift">
              {shiftAllowanceLine(mine.shifts, mine.allowanceMinutes, clock)}
            </p>
          )}
          {mine.saved && <p className="text-lg font-bold" data-testid="break-current">Tu descanso: {rangeWords(mine.saved)}</p>}
          {mine.shifts.length === 0 && <p className="text-lg font-semibold">No hay horarios hoy.</p>}
          {faces.length > 0 && !showingLengths && (
            <div className="grid grid-cols-2 gap-2" data-testid="break-starts">
              {faces.map((face) => (
                <button
                  key={face.startAt}
                  type="button"
                  className="min-h-14 rounded-lg border-2 border-neutral-950 px-2 text-xl font-bold disabled:opacity-40"
                  data-testid="break-start"
                  data-start={face.startAt}
                  data-reason={face.reason ?? ""}
                  disabled={busy || face.disabled}
                  onClick={() => {
                    setChosenEnd(null);
                    setChosenStart(face.startAt);
                  }}
                >
                  <span className="block">{clock(face.startAt)}</span>
                  {face.reason && <span className="block text-sm font-semibold">{face.reason}</span>}
                </button>
              ))}
            </div>
          )}
          {showingLengths && selected && (
            <LengthStep
              busy={busy}
              lengths={lengths}
              selected={selected}
              onBack={() => {
                setChosenEnd(null);
                setChosenStart(null);
              }}
              onChoose={(slot) => setChosenEnd(slot.endAt)}
              onSave={() => void pick(selected)}
            />
          )}
          {mine.saved && (
            <button type="button" className="min-h-14 rounded-lg border-2 border-neutral-950 text-lg font-bold" data-testid="break-clear" disabled={busy} onClick={() => void clearBreak()}>
              Quitar descanso
            </button>
          )}
        </section>
      )}
      {phase === "saved" && mine?.saved && (
        <section className="flex flex-col gap-3" data-testid="break-saved">
          <p className="text-2xl font-bold" data-testid="break-name">{mine.name}</p>
          <p className="text-lg font-bold" data-testid="break-saved-title">Listo. Tu descanso:</p>
          <p className="text-3xl font-bold">{rangeWords(mine.saved)}</p>
          <button
            type="button"
            className="self-start rounded-lg border-2 border-neutral-950 px-3 py-1 text-sm font-bold"
            data-testid="break-saved-clear"
            disabled={busy}
            onClick={() => void clearBreak()}
          >
            Quitar
          </button>
        </section>
      )}
    </main>
  );
}

function BackHome({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      className="min-h-14 rounded-lg border-2 border-neutral-950 text-lg font-bold"
      data-testid="break-back"
      onClick={onBack}
    >
      Volver
    </button>
  );
}

function LengthStep({
  busy,
  lengths,
  selected,
  onBack,
  onChoose,
  onSave,
}: {
  busy: boolean;
  lengths: BreakChoice[];
  selected: BreakChoice;
  onBack: () => void;
  onChoose: (slot: BreakChoice) => void;
  onSave: () => void;
}) {
  const others = lengths.filter((slot) => slot.endAt !== selected.endAt);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="min-h-12 rounded-lg border-2 border-neutral-950 text-lg font-bold"
        data-testid="break-start-back"
        disabled={busy}
        onClick={onBack}
      >
        Otro inicio
      </button>
      <button
        type="button"
        className="min-h-24 rounded-2xl border-4 border-neutral-950 bg-neutral-950 px-3 text-2xl font-bold text-white disabled:opacity-40"
        data-testid="break-save"
        data-start={selected.startAt}
        data-end={selected.endAt}
        disabled={busy}
        onClick={onSave}
      >
        <span className="block">Guardar</span>
        <span className="block text-lg font-semibold">{breakSaveLine(selected, clock)}</span>
      </button>
      {others.length > 0 && (
        <div className="grid grid-cols-2 gap-2" data-testid="break-lengths">
          {others.map((slot) => (
            <button
              key={`${slot.startAt}-${slot.endAt}`}
              type="button"
              className="min-h-12 rounded-lg border-2 border-neutral-950 px-2 text-lg font-bold"
              data-testid="break-slot"
              data-start={slot.startAt}
              data-end={slot.endAt}
              disabled={busy}
              onClick={() => onChoose(slot)}
            >
              {breakLengthMinutes(slot)} min
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
