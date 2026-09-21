"use client";

import type { BoardViolation } from "@/lib/violations";
import type { Messages } from "@/lib/i18n";

type Props = {
  violations: BoardViolation[];
  t: Messages;
};

/** Red banner listing slipped-in rule breaks (SPEC slice 12). */
export function ViolationsBanner({ violations, t }: Props) {
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
          <li key={`${v.assignmentId}-${v.code}-${i}`}>
            <span className="font-extrabold">{v.code}</span>
            {" — "}
            {v.employeeName} @ {v.stationId} ({v.hourLabel}): {v.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
