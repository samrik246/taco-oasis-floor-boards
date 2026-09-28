"use client";

import { useCallback, useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { useSearchParams } from "next/navigation";
import { STAFF_SESSION_HEADER } from "@/lib/breaks/header";
import { TIMEZONE } from "@/lib/constants";

export const BREAK_SAVED_MS = 10_000;
export const BREAK_IDLE_MS = 60_000;

type Phase = "home" | "keypad" | "picker" | "saved" | "expired";

type Slot = { startAt: string; endAt: string };

type Mine = {
  name: string;
  allowanceMinutes: number;
  slots: Slot[];
  saved: Slot | null;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"] as const;

function clock(iso: string): string {
  return formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");
}

function range(slot: Slot): string {
  return `${clock(slot.startAt)}–${clock(slot.endAt)}`;
}

export function DescansosScreen() {
  const params = useSearchParams();
  const boardParam = params.get("board");
  const board = boardParam === "caja" || boardParam === "cocina" ? boardParam : null;
  const [phase, setPhase] = useState<Phase>("home");
  const [digits, setDigits] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [message, setMessage] = useState("");
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);

  const goHome = useCallback((next: Phase = "home") => {
    setToken(null);
    setMine(null);
    setDigits("");
    setPaused(false);
    setPhase(next);
  }, []);

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
    if (!token || phase === "saved" || phase === "home" || phase === "keypad") return;
    let timer = window.setTimeout(() => goHome("home"), BREAK_IDLE_MS);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => goHome("home"), BREAK_IDLE_MS);
    };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
    };
  }, [token, phase, goHome]);

  useEffect(() => {
    if (phase !== "saved") return;
    const timer = window.setTimeout(() => goHome("home"), BREAK_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [phase, goHome]);

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
        setMessage(body.error ?? "Espera 1 minuto");
        window.setTimeout(() => setPaused(false), 60_000);
        return;
      }
      if (!response.ok || !body.token) {
        setMessage(body.error ?? "Ese código no coincide.");
        return;
      }
      setToken(body.token);
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
      goHome("home");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 bg-white p-6 text-neutral-950" data-testid="break-home" data-phase={phase}>
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
        <button
          type="button"
          className="min-h-40 rounded-2xl border-4 border-neutral-950 bg-neutral-950 text-4xl font-bold text-white"
          data-testid="break-personal"
          onClick={() => { setMessage(""); setPhase("keypad"); }}
        >
          Personal
        </button>
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
        </section>
      )}
      {phase === "picker" && mine && (
        <section className="flex flex-col gap-4">
          <p className="text-2xl font-bold" data-testid="break-name">{mine.name}</p>
          <p className="text-sm font-semibold">{mine.allowanceMinutes} minutos</p>
          {mine.saved && <p className="text-lg font-bold" data-testid="break-current">Tu descanso: {range(mine.saved)}</p>}
          <div className="grid grid-cols-2 gap-2">
            {mine.slots.map((slot) => (
              <button
                key={`${slot.startAt}-${slot.endAt}`}
                type="button"
                className="min-h-14 rounded-lg border-2 border-neutral-950 px-2 text-base font-bold"
                data-testid="break-slot"
                data-start={slot.startAt}
                data-end={slot.endAt}
                disabled={busy}
                onClick={() => void pick(slot)}
              >
                {range(slot)}
              </button>
            ))}
          </div>
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
          <p className="text-3xl font-bold">{range(mine.saved)}</p>
        </section>
      )}
    </main>
  );
}
