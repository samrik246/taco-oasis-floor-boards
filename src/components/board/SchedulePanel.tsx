"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  buildScheduleGrid,
  type ScheduleMode,
  type ScheduleSort,
} from "@/lib/schedule/build-schedule";
import { stationSolidClass } from "@/lib/schedule/station-codes";
import { formatCompactHour, formatHourLabel } from "@/lib/hour-grid";
import { displayStationLabel, type Locale, type Messages } from "@/lib/i18n";
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

const NAME_COL = "left-0 w-[10.5rem] min-w-[10.5rem] max-w-[10.5rem]";
const SHIFT_COL = "left-[10.5rem] w-[4.25rem] min-w-[4.25rem] max-w-[4.25rem]";

/**
 * People × hours schedule.
 * By name (default): sticky person + shift, colored blocks show the position code.
 * By position: thin section labels, colored blocks show the person’s name.
 * No full-width station banner rows.
 */
export function SchedulePanel({ day, date, locale, t, now }: Props) {
  const [mode, setMode] = useState<ScheduleMode>("all-day");
  const [sort, setSort] = useState<ScheduleSort>("name");

  const grid = useMemo(() => {
    if (!day || !date) return null;
    return buildScheduleGrid({
      date,
      shifts: day.shifts,
      stations: day.stations.map((s) => ({
        id: s.id,
        label: displayStationLabel(locale, s),
        color: s.color,
        sortOrder: s.sortOrder,
        shortCode: s.shortCode,
      })),
      mode,
      sort,
      now,
      unassignedGroupLabel: t.scheduleUnassignedGroup,
    });
  }, [day, date, locale, mode, now, sort, t.scheduleUnassignedGroup]);

  const restHint =
    grid?.restRule === "today-from-now"
      ? t.scheduleRestRuleToday
      : grid?.restRule === "other-from-first-scheduled"
        ? t.scheduleRestRuleOther
        : null;

  const peopleCount =
    grid?.sections.reduce((n, section) => n + section.rows.length, 0) ?? 0;

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="schedule-panel"
      data-mode={mode}
      data-sort={sort}
      data-locale={locale}
      data-station-banners="false"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold" data-testid="schedule-title">
            {t.scheduleTitle}
          </h2>
          <p className="max-w-xl text-xs font-medium text-neutral-600">
            {t.scheduleHint}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border-2 border-neutral-700 p-1"
            role="group"
            aria-label={t.scheduleSortLabel}
            data-testid="schedule-sort-toggle"
          >
            {(
              [
                ["name", t.scheduleSortName],
                ["time", t.scheduleSortTime],
                ["position", t.scheduleSortPosition],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={cn(
                  "touch-target min-h-11 rounded-md px-3 text-sm font-semibold active:opacity-90",
                  sort === id
                    ? "bg-neutral-800 text-white"
                    : "bg-white text-neutral-900 active:bg-neutral-200",
                )}
                aria-pressed={sort === id}
                onClick={() => setSort(id)}
                data-testid={`schedule-sort-${id}`}
              >
                {label}
              </button>
            ))}
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

      {!grid || peopleCount === 0 ? (
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
                  className={cn(
                    "sticky z-20 border-b-2 border-r border-neutral-900 bg-white px-2 py-1.5 text-sm font-bold",
                    NAME_COL,
                  )}
                  scope="col"
                >
                  {t.person}
                </th>
                <th
                  className={cn(
                    "sticky z-20 border-b-2 border-r-2 border-neutral-900 bg-white px-1 py-1.5 text-center text-xs font-bold",
                    SHIFT_COL,
                  )}
                  scope="col"
                >
                  {t.scheduleShiftCol}
                </th>
                {grid.hours.map((h) => (
                  <th
                    key={h}
                    className="min-w-[3.4rem] border-b-2 border-neutral-900 px-0.5 py-1.5 text-center text-xs font-bold"
                    scope="col"
                    data-testid={`schedule-hour-${h}`}
                  >
                    {formatCompactHour(h)}
                  </th>
                ))}
              </tr>
              <tr data-testid="schedule-headcount-row">
                <th
                  colSpan={2}
                  className="sticky left-0 z-20 border-b border-r-2 border-neutral-300 bg-neutral-50 px-2 py-0.5 text-left text-[11px] font-bold"
                >
                  {t.scheduleHeadcount}
                </th>
                {grid.headcount.map((n, i) => (
                  <td
                    key={grid.hours[i]}
                    className="border-b border-neutral-300 bg-neutral-50 px-0.5 py-0.5 text-center text-xs font-bold tabular-nums"
                    data-testid={`schedule-headcount-${grid.hours[i]}`}
                  >
                    {n}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.sections.map((section) => (
                <Fragment key={`s-${section.stationId ?? "all"}-${section.label ?? "flat"}`}>
                  {section.label ? (
                    <tr
                      data-testid={`schedule-section-${section.stationId ?? "unassigned"}`}
                      data-section-kind="thin"
                      data-station-banner="false"
                      className="h-5"
                    >
                      <th
                        colSpan={2}
                        className="sticky left-0 z-10 border-b border-r-2 border-neutral-300 bg-neutral-100 px-2 py-0 text-left text-[10px] font-bold uppercase leading-5 tracking-wide text-neutral-700"
                        scope="rowgroup"
                      >
                        {section.label}
                      </th>
                      {grid.hours.map((h) => (
                        <td
                          key={h}
                          className="border-b border-neutral-200 bg-neutral-100 p-0"
                        />
                      ))}
                    </tr>
                  ) : null}
                  {section.rows.map((row) => (
                    <tr
                      key={row.employeeId}
                      data-testid={`schedule-row-${row.externalId}`}
                      data-start={row.startLabel}
                    >
                      <th
                        className={cn(
                          "sticky z-10 border-b border-r border-neutral-300 bg-white px-2 py-1 text-sm font-bold",
                          NAME_COL,
                        )}
                        scope="row"
                      >
                        <span className="flex min-h-9 items-center gap-2 leading-tight">
                          {sort === "time" && (
                            <span
                              className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-xs font-extrabold tabular-nums text-white"
                              data-testid="schedule-start"
                            >
                              {row.startLabel}
                            </span>
                          )}
                          <span>{row.name}</span>
                        </span>
                      </th>
                      <td
                        className={cn(
                          "sticky z-10 border-b border-r-2 border-neutral-300 bg-white px-1 py-1 text-center text-[11px] font-semibold tabular-nums",
                          SHIFT_COL,
                        )}
                      >
                        {row.shiftLabel}
                      </td>
                      {renderRowCells(row, grid.hours)}
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr data-testid="schedule-manhours-row">
                <th
                  colSpan={2}
                  className="sticky left-0 z-10 border-t border-r-2 border-neutral-300 bg-neutral-50 px-2 py-0.5 text-left text-[11px] font-bold"
                >
                  {t.scheduleManHours}
                </th>
                {grid.manHours.map((n, i) => (
                  <td
                    key={grid.hours[i]}
                    className="border-t border-neutral-300 bg-neutral-50 px-0.5 py-0.5 text-center text-xs font-bold tabular-nums"
                    data-testid={`schedule-manhours-${grid.hours[i]}`}
                  >
                    {n}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function renderRowCells(
  row: {
    name: string;
    hourStations: Map<number, string | null | undefined>;
    blocks: Array<{
      stationId: string;
      code: string;
      text: string;
      textKind: "position" | "person";
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
              "flex min-h-9 items-center justify-center rounded-sm px-1 text-center text-[11px] font-extrabold leading-tight tracking-wide",
              stationSolidClass(block.color),
            )}
            data-text-kind={block.textKind}
            data-code={block.code}
            data-person={row.name}
          >
            {block.text}
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
        <span className="block min-h-9 content-center">
          {status === null ? "·" : ""}
        </span>
      </td>,
    );
    i += 1;
  }
  return cells;
}
