"use client";

import type { BoardViolation } from "@/lib/violations";
import { boardStationLabel, type Locale, type Messages } from "@/lib/i18n";
import { violationMessage } from "@/lib/violation-messages";
import type { StationDto } from "./types";

type Props = {
  violations: BoardViolation[];
  stations: readonly StationDto[];
  locale: Locale;
  t: Messages;
};

/** Red banner listing slipped-in rule breaks (SPEC slice 12). */
export function ViolationsBanner({ violations, stations, locale, t }: Props) {
  if (violations.length === 0) return null;

  return (
    <div
      className="mx-3 mt-3 rounded-md border-2 border-red-900 bg-red-100 px-4 py-3 text-red-950 sm:mx-4"
      role="alert"
      data-testid="violations-banner"
    >
      <p className="text-base font-bold">{t.violations(violations.length)}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm font-semibold">
        {violations.map((v, i) => (
          <li key={`${v.assignmentId??v.interval?.shiftId}-${v.code}-${i}`}>
            <span className="font-extrabold">{v.code}</span>
            {" — "}
            {v.employeeName} @ {boardStationLabel(locale, v.stationId, stations)} ({v.hourLabel}):{" "}
            {violationMessage(locale, v.code, v.message)}
          </li>
        ))}
      </ul>
    </div>
  );
}
