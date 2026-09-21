"use client";

import { useEffect, useMemo, useState } from "react";
import { chicagoHourStart, formatCompactHour, formatHourLabel, hourGridHours } from "@/lib/hour-grid";
import {
  buildRushForecast,
  earlierRushText,
  RUSH_MEDIAN_RATIO,
  rushSummaryText,
  type RushForecast,
  type RushHourStat,
} from "@/lib/rush/forecast";
import { resolveRestOfDayStart } from "@/lib/schedule/build-schedule";
import { isHourInShift } from "@/lib/rules/shift-window";
import type { Locale, Messages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { BoardKindUi, DayBoardDto } from "./types";

type Props = {
  day: DayBoardDto | null;
  date: string;
  board: BoardKindUi;
  locale: Locale;
  t: Messages;
  now?: Date;
};

type RangeMode = "all-day" | "rest-of-day";

/**
 * Historical rush timeline (7a–9p). Highlights hours whose share of that
 * day’s sales beats the weekday median. Not order counts. Not a live POS.
 */
export function RushPanel({ day, date, board, locale, t, now }: Props) {
  const [mode, setMode] = useState<RangeMode>("all-day");
  const [remote, setRemote] = useState<RushForecast | null>(null);

  useEffect(() => {
    if (!date) {
      setRemote(null);
      return;
    }
    let cancel = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/rush?board=${board}&date=${encodeURIComponent(date)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { forecast: RushForecast };
        if (!cancel) setRemote(data.forecast);
      } catch {
        if (!cancel) setRemote(null);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [board, date]);

  const forecast = useMemo(() => {
    if (!date) return null;
    if (remote && remote.board === board) return remote;
    return buildRushForecast({ board, dateYmd: date });
  }, [board, date, remote]);

  const windowStart = useMemo(() => {
    if (!forecast || mode !== "rest-of-day" || !date) return null;
    const allHours = hourGridHours();
    const covered: number[] = [];
    const shifts = day?.shifts ?? [];
    for (const hour of allHours) {
      const hourStart = chicagoHourStart(date, hour);
      const any = shifts.some((sh) =>
        isHourInShift(hourStart, new Date(sh.startAt), new Date(sh.endAt)),
      );
      if (any) covered.push(hour);
    }
    return resolveRestOfDayStart({
      dateYmd: date,
      now,
      hoursWithShiftCoverage: covered,
    });
  }, [date, day?.shifts, forecast, mode, now]);

  const visible = useMemo(() => {
    if (!forecast) return [];
    if (!windowStart) return forecast.hours;
    return forecast.hours.filter((h) => h.hour >= windowStart.startHour);
  }, [forecast, windowStart]);

  const maxMean = Math.max(1, ...visible.map((h) => h.mean));
  const summary = forecast ? rushSummaryText(forecast, locale) : "";
  const earlier =
    forecast && windowStart
      ? earlierRushText(forecast, windowStart.startHour, locale)
      : null;

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="rush-panel"
      data-metric="percent-of-day"
      data-mode={mode}
      data-locale={locale}
      data-board={board}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold" data-testid="rush-title">
            {t.rushTitle}
          </h2>
          <p className="max-w-xl text-xs font-medium text-neutral-600">
            {t.rushHint}
          </p>
        </div>
        <div
          className="inline-flex rounded-lg border-2 border-neutral-700 p-1"
          role="group"
          aria-label={t.scheduleModeLabel}
          data-testid="rush-mode-toggle"
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
              data-testid={`rush-mode-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!date || !forecast ? (
        <p
          className="rounded-md border-2 border-dashed border-neutral-400 px-3 py-6 text-center text-sm font-medium text-neutral-600"
          data-testid="rush-empty"
        >
          {t.rushEmptyDate}
        </p>
      ) : (
        <>
          <p
            className="text-base font-bold leading-snug text-neutral-950"
            data-testid="rush-summary"
          >
            {summary}
          </p>
          <p
            className="text-sm font-semibold text-neutral-800"
            data-testid="rush-prep"
          >
            {t.rushPrep}
          </p>
          {earlier && (
            <p
              className="text-xs font-semibold text-neutral-600"
              data-testid="rush-earlier"
            >
              {earlier}
            </p>
          )}
          {windowStart && mode === "rest-of-day" && (
            <p className="text-xs font-semibold text-neutral-600">
              {windowStart.rule === "today-from-now"
                ? t.scheduleRestRuleToday
                : t.scheduleRestRuleOther}{" "}
              <span className="tabular-nums">
                ({formatHourLabel(windowStart.startHour)} – {formatHourLabel(21)})
              </span>
            </p>
          )}

          <div className="overflow-x-auto" data-testid="rush-timeline">
            <ol className="flex min-w-max gap-1.5 pb-1">
              {visible.map((hour) => (
                <HourColumn
                  key={hour.hour}
                  hour={hour}
                  maxMean={maxMean}
                  rushLabel={t.rushMark}
                  ordersLabel={t.rushOrders}
                />
              ))}
            </ol>
          </div>

          <p
            className="text-xs font-semibold text-neutral-700"
            data-testid="rush-basis"
          >
            {t.rushBasis}
          </p>
          <p
            className="text-[11px] font-medium text-neutral-500"
            data-testid="rush-method"
          >
            {t.rushMethod}{" "}
            <span className="tabular-nums">
              {forecast.dayMedian.toFixed(1)} {t.rushOrders} ·{" "}
              {RUSH_MEDIAN_RATIO}× → {forecast.threshold.toFixed(1)}
            </span>
          </p>
        </>
      )}
    </section>
  );
}

function HourColumn({
  hour,
  maxMean,
  rushLabel,
  ordersLabel,
}: {
  hour: RushHourStat;
  maxMean: number;
  rushLabel: string;
  ordersLabel: string;
}) {
  const height = Math.max(8, Math.round((hour.mean / maxMean) * 88));
  return (
    <li
      className={cn(
        "flex w-[4.4rem] shrink-0 flex-col items-center gap-1 rounded-md border px-1 py-1.5",
        hour.rush
          ? "border-orange-700 bg-orange-50"
          : "border-neutral-200 bg-white",
      )}
      data-testid={`rush-hour-${hour.hour}`}
      data-rush={hour.rush ? "true" : "false"}
      data-mean={hour.mean.toFixed(1)}
    >
      <span className="text-xs font-bold tabular-nums">
        {formatCompactHour(hour.hour)}
      </span>
      <span
        className={cn(
          "text-[10px] font-extrabold uppercase tracking-wide",
          hour.rush ? "text-orange-800" : "text-transparent",
        )}
        aria-hidden={!hour.rush}
      >
        {rushLabel}
      </span>
      <div className="flex h-[5.5rem] w-full items-end justify-center">
        <div
          className={cn(
            "w-8 rounded-sm",
            hour.rush ? "bg-orange-500" : "bg-neutral-300",
          )}
          style={{ height }}
        />
      </div>
      <span className="text-[11px] font-bold tabular-nums">
        {hour.mean.toFixed(1)}
      </span>
      <span className="text-[10px] font-medium text-neutral-500">
        {ordersLabel}
      </span>
    </li>
  );
}
