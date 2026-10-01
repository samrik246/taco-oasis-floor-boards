"use client";

import { savedHourSegments } from "./cover-display";
import { SavedCoverPanel, SavedCoverRows, SavedShiftHour } from "./SavedCoverDisplay";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  buildScheduleGrid,
  type ScheduleMode,
  type ScheduleSort,
} from "@/lib/schedule/build-schedule";
import { stationSolidClass } from "@/lib/schedule/station-codes";
import { formatCompactHour, formatHourLabel } from "@/lib/hour-grid";
import { personQuarters, type QuarterView } from "@/lib/slices/day-slices";
import { removedHours } from "@/lib/overlays/read";
import { displayStationLabel, type Locale, type Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AmberMark } from "./AmberMark";
import { amberHoursForDay, slicesForDay } from "./day-slice-input";
import { QuarterRow } from "./QuarterRow";
import type { DayBoardDto } from "./types";
import { T4gStrip } from "./T4gStrip";

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
 * By time (default): sticky person + shift, rows follow start time,
 * colored blocks show the full position name.
 * By position: thin section labels, colored blocks show the person’s name.
 * No full-width station banner rows.
 */
export function SchedulePanel({ day, date, locale, t, now }: Props) {
  const [mode, setMode] = useState<ScheduleMode>("rest-of-day");
  const [sort, setSort] = useState<ScheduleSort>("time");

  const slices = useMemo(() => (day && date ? slicesForDay(day, now ?? new Date()) : null), [day, date, now]);
  const amberByShift = useMemo(() => (day ? amberHoursForDay(day, now ?? new Date()) : new Map<string, Set<number>>()), [day, now]);
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
  const stationLabels = new Map(
    (day?.stations ?? []).map((station) => [station.id, displayStationLabel(locale, station)]),
  );

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="schedule-panel"
      data-mode={mode}
      data-sort={sort}
      data-locale={locale}
      data-station-banners="false"
    >
      <T4gStrip date={date} locale={locale} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold" data-testid="schedule-title">
            {t.scheduleTitle}
          </h2>
          <details className="text-xs font-medium text-neutral-700">
            <summary className="cursor-pointer font-semibold">{t.scheduleHelp}</summary>
            <p className="mt-1 max-w-xl">{t.scheduleHint}</p>
          </details>
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
                    className="min-w-[9rem] border-b-2 border-neutral-900 px-0.5 py-1.5 text-center text-xs font-bold"
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
                      key={row.shiftId}
                      data-testid={`schedule-row-${row.shiftId}`}
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
                          {(sort === "time" || row.laterShiftOfPerson) && (
                            <span
                              className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-xs font-extrabold tabular-nums text-white"
                              data-testid="schedule-start"
                            >
                              {row.startLabel}
                            </span>
                          )}
                          <span>{row.name}</span>
                          {row.ended && (
                            <span
                              className="shrink-0 rounded border border-neutral-500 px-1 text-[10px] font-bold uppercase text-neutral-600"
                              data-testid="schedule-ended"
                            >
                              {t.shiftEnded}
                            </span>
                          )}
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
                      {renderRowCells(row, grid.hours, stationLabels, {
                        savedFor: (hour) => day && savedHourSegments(day, row.shiftId, hour) ? <SavedShiftHour day={day} shiftId={row.shiftId} hour={hour} locale={locale} /> : null,
                        quartersFor: (hour) => (slices ? personQuarters(slices, row.employeeId, hour) : []),
                        amberHours: amberByShift.get(row.shiftId) ?? new Set<number>(),
                        removedHours: removedHours(day?.overlays ?? [], row.employeeId, date, now ?? new Date()),
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
              {day && <SavedCoverRows day={day} locale={locale} hours={grid.hours} leadingColumns={2} />}
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
      {day && <SavedCoverPanel day={day} locale={locale} hours={grid?.hours} rows={peopleCount === 0} />}
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
      seatNumber: number | null;
    }>;
  },
  hours: number[],
  stationLabels: ReadonlyMap<string, string>,
  marks: {
    savedFor: (hour: number) => ReactNode;
    quartersFor: (hour: number) => QuarterView[];
    amberHours: Set<number>;
    removedHours: Set<number>;
  },
) {
  const openAt = (hour: number) => marks.quartersFor(hour).some((quarter) => quarter.kind === "open");
  const markedAt = (hour: number) => marks.quartersFor(hour).some((quarter) => {
    return quarter.kind === "break" || quarter.auto === true;
  });
  const cells: ReactNode[] = [];
  let i = 0;
  while (i < hours.length) {
    const hour = hours[i]!;
    const saved = marks.savedFor(hour);
    if (saved) {
      cells.push(<td key={`${hour}-saved`} className="border-b border-neutral-300 p-0.5" data-testid={row.hourStations.get(hour) ? `schedule-block-${row.hourStations.get(hour)}-${hour}` : `schedule-saved-${hour}`}>{saved}</td>);
      i += 1;
      continue;
    }
    const original = row.blocks.find((b) => b.startHour <= hour && hour < b.startHour + b.span);
    const needsOwnCell = (h: number) => Boolean(marks.savedFor(h)) || openAt(h) || markedAt(h) || marks.removedHours.has(h);
    // A marked hour splits only itself. Adjacent unmarked hours in the same
    // assignment/seat block still join, including the evening after a BREAK.
    let span = 1;
    if (original && !needsOwnCell(hour)) {
      while (i + span < hours.length && hours[i + span] === hour + span &&
        hours[i + span]! < original.startHour + original.span && !needsOwnCell(hours[i + span]!)) span += 1;
    }
    const block = original ? { ...original, startHour: hour, span } : undefined;
    const blockHasOpen = block != null && needsOwnCell(hour);
    if (block && !blockHasOpen) {
      const fullLabel = stationLabels.get(block.stationId) ?? block.code;
      const visibleText = block.textKind === "position" ? fullLabel : block.text;
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
          >
            <details className="group relative w-full">
              <summary
                className="cursor-pointer list-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                data-text-kind={block.textKind}
                data-code={block.code}
                data-person={row.name}
                aria-label={block.textKind === "position" ? fullLabel : `${block.text}: ${fullLabel}`}
                title={fullLabel}
              >
                {visibleText}
              </summary>
              <span className="absolute left-0 top-full z-30 hidden min-w-max max-w-72 rounded border border-neutral-900 bg-white px-2 py-1 text-left text-xs font-bold normal-case tracking-normal text-neutral-950 shadow-lg group-open:block group-focus-within:block">
                {fullLabel}
              </span>
            </details>
          </div>
        </td>,
      );
      i += block.span;
      continue;
    }
    if (block && blockHasOpen) {
      const end = hour + block.span;
      const fullLabel = stationLabels.get(block.stationId) ?? block.code;
      const visibleText = block.textKind === "position" ? fullLabel : block.text;
      while (i < hours.length && hours[i]! < end) {
        const sliceHour = hours[i]!;
        if (marks.removedHours.has(sliceHour)) {
          cells.push(
            <td key={`${sliceHour}-removed`} className="relative border-b border-neutral-300 bg-amber-50 p-0.5 text-center" data-kind="open" data-testid={`schedule-removed-${sliceHour}`}>
              <AmberMark kind="removed-hour" />
              <span className="block min-h-9 content-center">·</span>
              <QuarterRow quarters={marks.quartersFor(sliceHour)} />
            </td>,
          );
          i += 1;
          continue;
        }
        cells.push(
          <td
            key={`${sliceHour}-${block.stationId}`}
            className="border-b border-neutral-300 p-0.5"
            data-station={block.stationId}
            data-testid={`schedule-block-${block.stationId}-${sliceHour}`}
          >
            <div
              className={cn(
                "relative flex min-h-9 flex-col items-center justify-center rounded-sm px-1 text-center text-[11px] font-extrabold leading-tight tracking-wide",
                stationSolidClass(block.color),
              )}
            >
              <span>{visibleText}</span>
              <QuarterRow quarters={marks.quartersFor(sliceHour)} />
            </div>
          </td>,
        );
        i += 1;
      }
      continue;
    }
    const status = row.hourStations.get(hour);
    const quarters = marks.quartersFor(hour);
    cells.push(
      <td
        key={hour}
        className={cn(
          "relative border-b border-neutral-300 px-0.5 py-1 text-center font-semibold",
          status === undefined && "text-neutral-300",
          status === null && "bg-amber-50 text-amber-900",
        )}
        data-kind={
          status === undefined ? "off" : status === null ? "open" : "seated"
        }
      >
        {marks.removedHours.has(hour) && <AmberMark kind="removed-hour" />}
        {status === null && !marks.removedHours.has(hour) && marks.amberHours.has(hour) && <AmberMark kind="empty-hour" />}
        <span className="block min-h-9 content-center">
          {status === null ? "·" : ""}
        </span>
        <QuarterRow quarters={quarters} />
      </td>,
    );
    i += 1;
  }
  return cells;
}
