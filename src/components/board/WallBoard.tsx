"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { KioskLock, kioskRequested } from "@/components/board/KioskLock";
import { assignmentsAtStationHour, displayName, stationColorClass } from "@/components/board/board-helpers";
import type { DayBoardDto } from "@/components/board/types";
import { readLastBoard, saveLastBoard } from "@/lib/offline-board";
import { chicagoHourOf } from "@/lib/hour-grid";
import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";
import { chicagoYmd } from "@/lib/schedule/build-schedule";
import {
  boardDisplayName,
  displayStationLabel,
  localeForBoard,
  messagesFor,
} from "@/lib/i18n";
import { rushLeadNotice, type RushForecast } from "@/lib/rush/forecast";
import { formatHourLabel } from "@/lib/hour-grid";
import { cn } from "@/lib/utils";

/**
 * Glance layout for a kitchen monitor or the MicroTouch.
 * Huge stations, current Chicago hour, no edit controls.
 */
export function WallBoard() {
  const searchParams = useSearchParams();
  const board = searchParams.get("board") === "cocina" ? "cocina" : "caja";
  const locale = localeForBoard(board);
  const t = messagesFor(locale);
  const kiosk = kioskRequested(searchParams);

  const [now, setNow] = useState(() => new Date());
  const [day, setDay] = useState<DayBoardDto | null>(null);
  const [offline, setOffline] = useState(false);
  const [forecast, setForecast] = useState<RushForecast | null>(null);

  const date = useMemo(() => {
    if (offline && day?.date) return day.date;
    return chicagoYmd(now);
  }, [day?.date, now, offline]);
  const hour = chicagoHourOf(now);
  const onGrid = hour >= HOUR_GRID_START && hour < HOUR_GRID_END;

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancel = false;
    const ymd = chicagoYmd(new Date());
    void (async () => {
      try {
        const res = await fetch(`/api/boards/${board}/days/${ymd}`);
        if (!res.ok) throw new Error("board");
        const data = (await res.json()) as DayBoardDto;
        if (cancel) return;
        setDay(data);
        setOffline(false);
        saveLastBoard({ board, date: ymd, day: data });
      } catch {
        if (cancel) return;
        const cached = readLastBoard();
        if (cached) {
          setDay(cached.day as DayBoardDto);
          setOffline(true);
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [board]);

  useEffect(() => {
    if (!date) return;
    let cancel = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/rush?board=${board}&date=${encodeURIComponent(date)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { forecast: RushForecast };
        if (!cancel) setForecast(data.forecast);
      } catch {
        /* wall still shows seats */
      }
    })();
    return () => {
      cancel = true;
    };
  }, [board, date]);

  const lead =
    forecast && date
      ? rushLeadNotice({ forecast, now, dateYmd: date, locale })
      : null;

  const clock = now.toLocaleTimeString(locale === "es" ? "es-MX" : "en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className="flex min-h-dvh flex-col bg-neutral-950 text-white"
      data-testid="wall-board"
      data-locale={locale}
      data-board={board}
      data-wall="1"
      data-readonly="1"
    >
      <KioskLock active={kiosk} />
      <header className="flex flex-wrap items-end justify-between gap-4 px-6 py-5">
        <div>
          <p className="text-sm font-bold uppercase tracking-widest text-neutral-400">
            {t.wallTitle}
          </p>
          <h1 className="text-4xl font-black tracking-tight md:text-5xl">
            {boardDisplayName(locale, board)}
          </h1>
          <p className="mt-1 text-lg font-semibold text-neutral-300">{t.wallHint}</p>
        </div>
        <div className="text-right">
          <p className="text-5xl font-black tabular-nums md:text-6xl" data-testid="wall-clock">
            {clock}
          </p>
          <p className="text-2xl font-bold text-amber-200" data-testid="wall-hour">
            {onGrid ? formatHourLabel(hour) : t.wallOffHours}
          </p>
          <p className="text-sm font-semibold text-neutral-400">{date} CT</p>
        </div>
      </header>

      {offline && (
        <p
          className="mx-6 rounded-md border-2 border-amber-400 bg-amber-100 px-4 py-2 text-lg font-bold text-amber-950"
          data-testid="offline-banner"
        >
          {t.offlineBanner}
        </p>
      )}
      {lead && (
        <p
          className="mx-6 mt-3 rounded-md border-2 border-orange-300 bg-orange-500 px-4 py-3 text-2xl font-black text-neutral-950"
          data-testid="rush-lead-banner"
          role="status"
        >
          {lead.text}
        </p>
      )}

      <div className="grid flex-1 grid-cols-2 gap-4 p-6 lg:grid-cols-3" data-testid="wall-stations">
        {(day?.stations ?? []).map((station) => {
          const occupied =
            day && onGrid
              ? assignmentsAtStationHour(day.shifts, station.id, day.date, hour)
              : [];
          const label = displayStationLabel(locale, station);
          return (
            <section
              key={station.id}
              data-testid={`wall-station-${station.id}`}
              className={cn(
                "flex min-h-40 flex-col justify-between rounded-xl border-4 p-4",
                stationColorClass(station.color),
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-2xl font-black md:text-3xl">{label}</h2>
                {station.shortCode ? (
                  <span className="text-lg font-black tabular-nums">{station.shortCode}</span>
                ) : null}
              </div>
              <p className="text-4xl font-black leading-tight md:text-5xl" data-testid={`wall-who-${station.id}`}>
                {occupied.length
                  ? occupied.map((item) => displayName(item.shift)).join(", ")
                  : t.wallEmptySeat}
              </p>
            </section>
          );
        })}
      </div>

      <footer className="px-6 pb-4 text-sm text-neutral-500">
        <Link href={`/?board=${board}`} data-testid="wall-exit" className="underline">
          {board === "cocina" ? "Salir" : "Exit wall"}
        </Link>
      </footer>
    </div>
  );
}
