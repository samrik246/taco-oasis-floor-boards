"use client";

import { useMemo } from "react";
import { hourGridHours, formatHourLabel } from "@/lib/hour-grid";
import { stationLabel, type Locale, type Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatStartLabel } from "@/lib/schedule/build-schedule";
import { buildTimelineRows, personName } from "./timeline-rows";
import type { DayBoardDto } from "./types";

type Props = {
  day: DayBoardDto | null;
  date: string;
  locale: Locale;
  t: Messages;
  /** Highlight the currently selected hour column */
  selectedHour: number;
  onSelectHour?: (hour: number) => void;
  managerMode?: boolean;
};

/**
 * People × time × position matrix for the active board/day.
 */
export function TimelinePanel({
  day,
  date,
  locale,
  t,
  selectedHour,
  onSelectHour,
  managerMode,
}: Props) {
  const hours = hourGridHours();

  const rows = useMemo(() => {
    if (!day || !date) return [];
    return buildTimelineRows({
      shifts: day.shifts,
      date,
      hours,
      offLabel: t.timelineOffShift,
      unassignedLabel: t.timelineUnassigned,
      stationLabelFor: (id) => stationLabel(locale, id),
    });
  }, [day, date, hours, locale, t]);

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="timeline-panel"
      data-manager={managerMode ? "1" : "0"}
    >
      <div>
        <h2 className="text-lg font-bold">{t.timelineTitle}</h2>
        <p className="text-xs font-medium text-neutral-600">{t.timelineHint}</p>
      </div>

      {rows.length === 0 && (
        <p
          className="rounded-md border-2 border-dashed border-neutral-400 px-3 py-6 text-center text-sm font-medium text-neutral-600"
          data-testid="timeline-empty"
        >
          {t.timelineEmpty}
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto" data-testid="timeline-matrix">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 min-w-[8rem] border-b-2 border-neutral-900 bg-white px-2 py-2 text-sm font-bold">
                  {t.person}
                </th>
                {hours.map((h) => (
                  <th
                    key={h}
                    className={cn(
                      "min-w-[4.5rem] border-b-2 border-neutral-900 px-1 py-2 text-center font-bold",
                      selectedHour === h && "bg-neutral-900 text-white",
                    )}
                  >
                    <button
                      type="button"
                      className="min-h-11 w-full px-1"
                      onClick={() => onSelectHour?.(h)}
                      data-testid={`timeline-hour-${h}`}
                    >
                      {formatHourLabel(h)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ shift, cells, laterShiftOfPerson }) => (
                <tr
                  key={shift.id}
                  data-testid={`timeline-row-${shift.id}`}
                  data-employee={shift.employee.externalId}
                >
                  <th className="sticky left-0 z-10 border-b border-neutral-300 bg-white px-2 py-2 text-sm font-bold">
                    <span className="flex items-center gap-2">
                      {laterShiftOfPerson && (
                        <span
                          className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-xs font-extrabold tabular-nums text-white"
                          data-testid="timeline-start"
                        >
                          {formatStartLabel(shift.startAt)}
                        </span>
                      )}
                      <span>{personName(shift)}</span>
                    </span>
                  </th>
                  {cells.map((cell, i) => (
                    <td
                      key={hours[i]}
                      className={cn(
                        "border-b border-neutral-300 px-1 py-1 text-center font-semibold",
                        selectedHour === hours[i] && "bg-neutral-100",
                        cell.kind === "off" && "text-neutral-400",
                        cell.kind === "open" && "bg-amber-50 text-amber-950",
                        cell.kind === "seated" && "bg-emerald-50 text-emerald-950",
                        cell.changedFromPrev &&
                          managerMode &&
                          "ring-2 ring-inset ring-amber-600",
                      )}
                      data-kind={cell.kind}
                      data-station={cell.stationId ?? ""}
                      title={
                        cell.changedFromPrev && managerMode
                          ? "Position change"
                          : undefined
                      }
                    >
                      <span className="block min-h-10 content-center leading-tight">
                        {cell.label}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
