"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  buildScheduleGrid,
  type ScheduleMode,
} from "@/lib/schedule/build-schedule";
import { stationSolidClass } from "@/lib/schedule/station-codes";
import { formatHourLabel } from "@/lib/hour-grid";
import { stationLabel, type Locale, type Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { DayBoardDto } from "./types";

type Props = {
  day: DayBoardDto | null;
  date: string;
  locale: Locale;
  t: Messages;
  /** Injected for tests / rest-of-day “now” */
  now?: Date;
};

/**
 * Spreadsheet-style schedule grid (cocina colores / caja colores).
 * Sticky name column, hour headcounts, station-colored blocks, all-day / rest-of-day.
 */
export function SchedulePanel({ day, date, locale, t, now }: Props) {
  const [mode, setMode] = useState<ScheduleMode>("all-day");

  const grid = useMemo(() => {
    if (!day || !date) return null;
    return buildScheduleGrid({
      date,
      shifts: day.shifts,
      stations: day.stations.map((s) => ({
        id: s.id,
        label: stationLabel(locale, s.id, s.label),
        color: s.color,
        sortOrder: s.sortOrder,
      })),
      mode,
      now,
      unassignedGroupLabel: t.scheduleUnassignedGroup,
    });
  }, [day, date, locale, mode, now, t.scheduleUnassignedGroup]);

  const restHint =
    grid?.restRule === "today-from-now"
      ? t.scheduleRestRuleToday
      : grid?.restRule === "other-from-first-scheduled"
        ? t.scheduleRestRuleOther
        : null;

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="schedule-panel"
      data-mode={mode}
      data-locale={locale}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold" data-testid="schedule-title">
            {t.scheduleTitle}
          </h2>
          <p className="text-xs font-medium text-neutral-600">
            {t.scheduleHint}
          </p>
        </div>

        <div
          className="inline-flex rounded-lg border-2 border-neutral-700 p-1"
          role="group"
          aria-label={t.scheduleModeLabel}
          data-testid="schedule-mode-toggle"
        >
          {(
            [
              ["all-day", t.scheduleAllDay],
              ["rest-of-day", t.scheduleRestOfDay],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                "touch-target min-h-11 rounded-md px-3 text-sm font-semibold active:opacity-90",
                mode === id
                  ? "bg-neutral-800 text-white"
                  : "bg-white text-neutral-900 active:bg-neutral-200",
              )}
              onClick={() => setMode(id)}
              data-testid={`schedule-mode-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {restHint && mode === "rest-of-day" && (
        <p
          className="rounded-md border border-neutral-400 bg-neutral-50 px-3 py-2 text-xs font-semibold text-neutral-800"
          data-testid="schedule-rest-rule"
          data-rule={grid?.restRule ?? ""}
        >
          {restHint}
          {grid != null && (
            <span className="ml-1 tabular-nums text-neutral-600">
              ({formatHourLabel(grid.restStartHour)} – {formatHourLabel(21)})
            </span>
          )}
        </p>
      )}

      {!grid || grid.groups.length === 0 ? (
        <p
          className="rounded-md border-2 border-dashed border-neutral-400 px-3 py-6 text-center text-sm font-medium text-neutral-600"
          data-testid="schedule-empty"
        >
          {t.scheduleEmpty}
        </p>
      ) : (
        <div className="overflow-x-auto" data-testid="schedule-grid">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                <th
                  className="sticky left-0 z-20 min-w-[9rem] border-b-2 border-r border-neutral-900 bg-white px-2 py-2 text-sm font-bold"
                  scope="col"
                >
                  {t.person}
                </th>
                <th
                  className="sticky left-[9rem] z-20 min-w-[4.5rem] border-b-2 border-r border-neutral-900 bg-white px-1 py-2 text-center text-xs font-bold"
                  scope="col"
                >
                  {t.scheduleShiftCol}
                </th>
                <th
                  className="sticky left-[13.5rem] z-20 min-w-[5.5rem] border-b-2 border-r-2 border-neutral-900 bg-white px-1 py-2 text-center text-xs font-bold"
                  scope="col"
                >
                  {t.scheduleAreaCol}
                </th>
                {grid.hours.map((h) => (
                  <th
                    key={h}
                    className="min-w-[3.25rem] border-b-2 border-neutral-900 px-0.5 py-2 text-center font-bold"
                    scope="col"
                    data-testid={`schedule-hour-${h}`}
                  >
                    {formatHourLabel(h)}
                  </th>
                ))}
              </tr>
              <tr data-testid="schedule-headcount-row">
                <th
                  colSpan={3}
                  className="sticky left-0 z-20 border-b border-r-2 border-neutral-400 bg-neutral-100 px-2 py-1.5 text-left text-xs font-bold"
                >
                  {t.scheduleHeadcount}
                </th>
                {grid.headcount.map((n, i) => (
                  <td
                    key={grid.hours[i]}
                    className="border-b border-neutral-400 bg-neutral-100 px-0.5 py-1.5 text-center text-sm font-bold tabular-nums"
                    data-testid={`schedule-headcount-${grid.hours[i]}`}
                  >
                    {n}
                  </td>
                ))}
              </tr>
              <tr data-testid="schedule-manhours-row">
                <th
                  colSpan={3}
                  className="sticky left-0 z-20 border-b-2 border-r-2 border-neutral-900 bg-neutral-50 px-2 py-1.5 text-left text-xs font-bold"
                >
                  {t.scheduleManHours}
                </th>
                {grid.manHours.map((n, i) => (
                  <td
                    key={grid.hours[i]}
                    className="border-b-2 border-neutral-900 bg-neutral-50 px-0.5 py-1.5 text-center text-sm font-bold tabular-nums"
                    data-testid={`schedule-manhours-${grid.hours[i]}`}
                  >
                    {n}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.groups.map((group) => (
                <Fragment key={`g-${group.stationId ?? "none"}`}>
                  <tr
                    data-testid={`schedule-group-${group.stationId ?? "unassigned"}`}
                  >
                    <th
                      colSpan={3 + grid.hours.length}
                      className={cn(
                        "sticky left-0 z-10 border-y border-neutral-800 px-2 py-2 text-left text-sm font-extrabold uppercase tracking-wide",
                        group.color
                          ? stationSolidClass(group.color)
                          : "bg-neutral-200 text-neutral-900",
                      )}
                    >
                      {group.label}
                    </th>
                  </tr>
                  {group.rows.map((row) => (
                    <tr
                      key={row.employeeId}
                      data-testid={`schedule-row-${row.externalId}`}
                    >
                      <th
                        className="sticky left-0 z-10 border-b border-r border-neutral-300 bg-white px-2 py-1.5 text-sm font-bold"
                        scope="row"
                      >
                        <span className="block min-h-10 content-center leading-tight">
                          {row.name}
                        </span>
                      </th>
                      <td className="sticky left-[9rem] z-10 border-b border-r border-neutral-300 bg-white px-1 py-1.5 text-center text-xs font-semibold tabular-nums">
                        {row.shiftLabel}
                      </td>
                      <td className="sticky left-[13.5rem] z-10 border-b border-r-2 border-neutral-300 bg-white px-1 py-1.5 text-center text-xs font-semibold">
                        {row.primaryStationId
                          ? stationLabel(locale, row.primaryStationId)
                          : "—"}
                      </td>
                      {renderRowCells(row, grid.hours)}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function renderRowCells(
  row: {
    hourStations: Map<number, string | null | undefined>;
    blocks: Array<{
      stationId: string;
      code: string;
      color: string;
      startHour: number;
      span: number;
    }>;
  },
  hours: number[],
) {
  const cells: ReactNode[] = [];
  let i = 0;
  while (i < hours.length) {
    const hour = hours[i]!;
    const block = row.blocks.find((b) => b.startHour === hour);
    if (block) {
      cells.push(
        <td
          key={`${hour}-${block.stationId}`}
          colSpan={block.span}
          className="border-b border-neutral-300 p-0.5"
          data-station={block.stationId}
          data-testid={`schedule-block-${block.stationId}-${hour}`}
        >
          <div
            className={cn(
              "flex min-h-10 items-center justify-center rounded-sm px-1 text-center text-[11px] font-extrabold tracking-wide",
              stationSolidClass(block.color),
            )}
          >
            {block.code}
          </div>
        </td>,
      );
      i += block.span;
      continue;
    }
    const status = row.hourStations.get(hour);
    cells.push(
      <td
        key={hour}
        className={cn(
          "border-b border-neutral-300 px-0.5 py-1 text-center font-semibold",
          status === undefined && "text-neutral-300",
          status === null && "bg-amber-50 text-amber-900",
        )}
        data-kind={
          status === undefined ? "off" : status === null ? "open" : "seated"
        }
      >
        <span className="block min-h-10 content-center">
          {status === null ? "·" : ""}
        </span>
      </td>,
    );
    i += 1;
  }
  return cells;
}
