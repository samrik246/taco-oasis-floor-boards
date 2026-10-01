"use client";

import { useCallback, useEffect, useState } from "react";
import { ShiftRemovalPanel } from "@/components/board/ShiftRemovalPanel";
import type { DayBoardDto } from "@/components/board/types";
import { fetchCompatibleBoard } from "@/lib/quarter/client/transport";
import { chicagoYmd } from "@/lib/schedule/build-schedule";

export function TurnosTab({ token }: { token: string }) {
  const [board, setBoard] = useState<"caja" | "cocina">("caja");
  const [date, setDate] = useState(() => chicagoYmd(new Date()));
  const [day, setDay] = useState<DayBoardDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCompatibleBoard(board,date,token);
    if (!res.day) {
      setDay(null);
      setError("No se pudo abrir ese día.");
      return;
    }
    setDay(res.day);
    setError(null);
  }, [board, date, token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchCompatibleBoard(board,date,token);
      if (cancelled) return;
      if (!res.day) {
        setDay(null);
        setError("No se pudo abrir ese día.");
        return;
      }
      setDay(res.day);
      setError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [board, date, token]);

  return (
    <section className="flex flex-col gap-3" data-testid="turnos-tab">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-bold">
          Tablero
          <select
            className="min-h-11 rounded border-2 border-neutral-900 px-2"
            value={board}
            data-testid="turnos-board"
            onChange={(event) => setBoard(event.target.value === "cocina" ? "cocina" : "caja")}
          >
            <option value="caja">Caja</option>
            <option value="cocina">Cocina</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-bold">
          Fecha
          <input
            type="date"
            className="min-h-11 rounded border-2 border-neutral-900 px-2"
            value={date}
            data-testid="turnos-date"
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="text-sm font-semibold text-red-900" data-testid="turnos-error">
          {error}
        </p>
      )}
      <ShiftRemovalPanel
        key={`${board}|${date}|${token}`}
        day={day}
        board={board}
        date={date}
        managerToken={token}
        readonly={false}
        onSaved={load}
      />
    </section>
  );
}
