"use client";

import { useEffect, useState } from "react";
import type { EmployeeHoursLedger } from "@/lib/ledger-types";
import { cn } from "@/lib/utils";

type Props = {
  employeeId: string | null;
  employeeName: string | null;
  weekOf: string;
  /** Bump to force refresh after assign/clear/swap */
  refreshKey: number;
};

/**
 * Hours this week by station for the selected employee (SPEC slice 11).
 */
export function HoursLedgerPanel({
  employeeId,
  employeeName,
  weekOf,
  refreshKey,
}: Props) {
  const [ledger, setLedger] = useState<EmployeeHoursLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!employeeId || !weekOf) {
      setLedger(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/employees/${employeeId}/hours?weekOf=${encodeURIComponent(weekOf)}`,
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (!cancelled) {
            setLedger(null);
            setError(data.error ?? "Failed to load hours");
          }
          return;
        }
        const data = (await res.json()) as EmployeeHoursLedger;
        if (!cancelled) setLedger(data);
      } catch {
        if (!cancelled) {
          setLedger(null);
          setError("Failed to load hours");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [employeeId, weekOf, refreshKey]);

  if (!employeeId) {
    return (
      <div
        className="flex flex-col gap-2 rounded-lg border-2 border-neutral-900 bg-white p-3"
        data-testid="hours-ledger"
        aria-label="Hours this week"
      >
        <h2 className="text-lg font-bold">Hours this week</h2>
        <p className="text-sm font-medium text-neutral-700">
          Select a person (tap their name on a station, or pick from Available)
          to see minutes by station.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="hours-ledger"
      aria-label={`Hours this week for ${employeeName ?? "employee"}`}
    >
      <h2 className="text-lg font-bold">Hours this week</h2>
      <p className="text-sm font-semibold text-neutral-900">
        {employeeName ?? "Employee"}
      </p>
      {ledger && (
        <p className="text-xs font-medium text-neutral-600">
          {ledger.weekStart} → {ledger.weekEnd} · {ledger.totalHours}h total
        </p>
      )}
      {loading && (
        <p className="text-sm font-medium text-neutral-600">Loading ledger…</p>
      )}
      {error && (
        <p className="rounded-md border-2 border-red-800 bg-red-50 px-2 py-2 text-sm font-semibold text-red-950">
          {error}
        </p>
      )}
      {!loading &&
        !error &&
        ledger &&
        ledger.byStation.length === 0 &&
        (ledger.byTarea?.length ?? 0) === 0 && (
          <p
            className="text-sm font-medium text-neutral-600"
            data-testid="hours-ledger-empty"
          >
            No station or tarea minutes yet this week.
          </p>
        )}
      {!loading && ledger && ledger.byStation.length > 0 && (
        <>
          <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-700">
            By station
          </h3>
          <ul className="flex flex-col gap-1.5" data-testid="hours-ledger-rows">
            {ledger.byStation.map((row) => (
              <li
                key={row.stationId}
                className={cn(
                  "flex min-h-11 items-center justify-between gap-2 rounded-md border border-neutral-400 bg-neutral-50 px-2 py-1.5 text-sm",
                )}
                data-station-id={row.stationId}
                data-minutes={row.minutes}
              >
                <span className="font-semibold">{row.stationLabel}</span>
                <span className="font-bold tabular-nums">
                  {row.minutes} min
                  <span className="ml-1 font-medium text-neutral-600">
                    ({row.hours}h)
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!loading && ledger && (ledger.byTarea?.length ?? 0) > 0 && (
        <>
          <h3 className="mt-1 text-xs font-bold uppercase tracking-wide text-neutral-700">
            By tarea ({ledger.totalTareaMinutes ?? 0} min)
          </h3>
          <ul
            className="flex flex-col gap-1.5"
            data-testid="hours-ledger-tarea-rows"
          >
            {ledger.byTarea.map((row) => (
              <li
                key={row.templateId}
                className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-neutral-400 bg-neutral-50 px-2 py-1.5 text-sm"
                data-template-id={row.templateId}
                data-minutes={row.minutes}
              >
                <span className="font-semibold">{row.templateLabel}</span>
                <span className="font-bold tabular-nums">
                  {row.minutes} min
                  <span className="ml-1 font-medium text-neutral-600">
                    ({row.hours}h)
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
