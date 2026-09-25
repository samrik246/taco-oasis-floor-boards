"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { UpcomingOrder } from "@/lib/upcoming/fence";
import type { UpcomingSnapshot } from "@/lib/upcoming/source";
import {
  addDays,
  addMonths,
  groupByDate,
  monthGrid,
  weekDays,
} from "@/lib/upcoming/calendar";
import { NEXT_COPY, guestsText, type NextCopy } from "./next-copy";
import { OrderDetail } from "./OrderDetail";
import {
  DEFAULT_PREFS,
  NEXT_COLUMNS,
  readPrefs,
  savePrefs,
  type NextPrefs,
  type NextView,
} from "./prefs";

type Payload = UpcomingSnapshot & { today: string };

/** The page asks again every 5 minutes; the host reads C1 on the same beat. */
const POLL_MS = 5 * 60 * 1000;
/** No good read for this long: say so on the page. */
const STALE_AFTER_MS = 15 * 60 * 1000;

export function OrderChip({
  order,
  t,
  showGuests,
  onOpen,
}: {
  order: UpcomingOrder;
  t: NextCopy;
  showGuests: boolean;
  onOpen: (o: UpcomingOrder) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(order)}
      className="w-full rounded border-2 border-neutral-900 bg-amber-100 px-1.5 py-1 text-left text-xs font-bold leading-tight sm:text-sm"
      data-testid={`next-chip-${order.id_tail}`}
    >
      <span className="tabular-nums">{order.event_time}</span> #{order.id_tail}
      <span className="block font-semibold">
        {t.fulfillType[order.fulfill_type]}
        {showGuests && order.guests != null && ` · ${guestsText(order.guests, t)}`}
      </span>
    </button>
  );
}

export function OrderRow({
  order: o,
  t,
  columns,
  onOpen,
}: {
  order: UpcomingOrder;
  t: NextCopy;
  columns: NextPrefs["columns"];
  onOpen: (o: UpcomingOrder) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(o)}
      className="flex w-full flex-wrap gap-x-4 rounded border-2 border-neutral-900 bg-white p-3 text-left"
      data-testid={`next-row-${o.id_tail}`}
    >
      <span className="font-black tabular-nums">{o.event_date}</span>
      <span className="font-bold tabular-nums">{o.event_time}</span>
      <span className="font-bold">#{o.id_tail}</span>
      {columns.fulfill && <span>{t.fulfillType[o.fulfill_type]}</span>}
      {columns.ready && o.ready_time && (
        <span>
          {t.ready} {o.ready_time}
        </span>
      )}
      {columns.guests && o.guests != null && (
        <span>
          {t.guests} {guestsText(o.guests, t)}
        </span>
      )}
    </button>
  );
}

function DayCell({
  day,
  today,
  inMonth,
  orders,
  t,
  showGuests,
  onOpen,
  tall,
}: {
  day: string;
  today: string;
  inMonth: boolean;
  orders: UpcomingOrder[];
  t: NextCopy;
  showGuests: boolean;
  onOpen: (o: UpcomingOrder) => void;
  tall?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 border border-neutral-300 p-1 ${tall ? "min-h-48" : "min-h-24"} ${
        inMonth ? "bg-white" : "bg-neutral-100 text-neutral-400"
      } ${day === today ? "outline outline-2 -outline-offset-2 outline-amber-500" : ""}`}
      data-testid={`next-day-${day}`}
    >
      <span className="text-xs font-bold tabular-nums">{Number(day.slice(8))}</span>
      {orders.map((o) => (
        <OrderChip key={o.id_tail} order={o} t={t} showGuests={showGuests} onOpen={onOpen} />
      ))}
    </div>
  );
}

export function NextOrders() {
  const [prefs, setPrefs] = useState<NextPrefs>(DEFAULT_PREFS);
  const [data, setData] = useState<Payload | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [open, setOpen] = useState<UpcomingOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  const t = NEXT_COPY[prefs.locale];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/upcoming", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Payload;
      setData(body);
      setAnchor((a) => a ?? body.today);
    } catch {
      setData((d) => (d ? { ...d, stale: true } : d));
    } finally {
      setLoading(false);
      setClock(Date.now());
    }
  }, []);

  useEffect(() => {
    // Tablet storage is only readable after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(readPrefs());
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const update = (next: NextPrefs) => {
    setPrefs(next);
    savePrefs(next);
  };

  const byDate = useMemo(() => groupByDate(data?.orders ?? []), [data]);
  const today = data?.today ?? "";
  const focus = anchor ?? today;

  const fetchedMs = data?.fetchedAt ? Date.parse(data.fetchedAt) : null;
  const off = data?.source === "off";
  const showStale = Boolean(
    data && !off && (data.stale || fetchedMs == null || clock - fetchedMs > STALE_AFTER_MS),
  );

  const step = (dir: 1 | -1) => {
    if (!focus) return;
    setAnchor(prefs.view === "month" ? addMonths(focus, dir) : addDays(focus, 7 * dir));
  };

  const views: NextView[] = ["month", "week", "list"];

  return (
    <main className="flex min-h-dvh flex-col gap-3 bg-neutral-50 p-3 sm:p-4" data-testid="next-app">
      <header className="flex flex-wrap items-center gap-2 border-b-2 border-neutral-900 pb-3">
        <h1 className="mr-2 text-xl font-black">{t.title}</h1>
        {data?.source === "fixture" && (
          <span
            className="rounded bg-neutral-900 px-2 py-0.5 text-xs font-bold text-white"
            data-testid="next-test-data"
          >
            {t.testData}
          </span>
        )}
        <div className="flex gap-1" role="group">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => update({ ...prefs, view: v })}
              className={`rounded border-2 border-neutral-900 px-3 py-1 text-sm font-bold ${
                prefs.view === v ? "bg-neutral-900 text-white" : "bg-white"
              }`}
              data-testid={`next-view-${v}`}
            >
              {t[v]}
            </button>
          ))}
        </div>
        {prefs.view !== "list" && (
          <div className="flex gap-1">
            <button type="button" className="rounded border-2 border-neutral-900 bg-white px-2 py-1 text-sm font-bold" onClick={() => step(-1)} data-testid="next-prev">
              ‹ {t.prev}
            </button>
            <button type="button" className="rounded border-2 border-neutral-900 bg-white px-2 py-1 text-sm font-bold" onClick={() => setAnchor(today || null)} data-testid="next-today">
              {t.today}
            </button>
            <button type="button" className="rounded border-2 border-neutral-900 bg-white px-2 py-1 text-sm font-bold" onClick={() => step(1)} data-testid="next-next">
              {t.next} ›
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => update({ ...prefs, locale: prefs.locale === "es" ? "en" : "es" })}
          className="rounded border-2 border-neutral-900 bg-white px-2 py-1 text-sm font-bold"
          data-testid="next-locale"
        >
          {prefs.locale === "es" ? "EN" : "ES"}
        </button>
        <div className="flex items-center gap-2 sm:ml-auto">
          <span className="text-sm font-semibold tabular-nums" data-testid="next-updated">
            {t.updated}:{" "}
            {fetchedMs == null
              ? t.never
              : new Date(fetchedMs).toLocaleTimeString(prefs.locale === "es" ? "es-MX" : "en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "America/Chicago",
                })}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded border-2 border-neutral-900 bg-white px-3 py-1 text-sm font-bold disabled:opacity-50"
            data-testid="next-refresh"
          >
            {t.refresh}
          </button>
          <Link href="/?board=cocina" className="text-sm font-bold underline" data-testid="next-back">
            {t.back}
          </Link>
        </div>
      </header>

      <fieldset className="flex flex-wrap items-center gap-3 text-sm" data-testid="next-columns">
        <legend className="sr-only">{t.columns}</legend>
        <span className="font-bold">{t.columns}:</span>
        {NEXT_COLUMNS.map((c) => (
          <label key={c} className="flex items-center gap-1 font-semibold">
            <input
              type="checkbox"
              checked={prefs.columns[c]}
              onChange={(e) =>
                update({ ...prefs, columns: { ...prefs.columns, [c]: e.target.checked } })
              }
              data-testid={`next-col-${c}`}
            />
            {t[c]}
          </label>
        ))}
      </fieldset>

      {showStale && (
        <p className="rounded border-2 border-red-700 bg-red-50 p-2 font-bold text-red-800" data-testid="next-stale">
          {t.stale}
        </p>
      )}
      {data && data.heldBack > 0 && (
        <p className="rounded border-2 border-amber-700 bg-amber-50 p-2 font-bold text-amber-900" data-testid="next-held">
          {t.heldBack(data.heldBack)}
        </p>
      )}

      {data && focus && prefs.view === "month" && (
        <div data-testid="next-month">
          <h2 className="mb-1 text-lg font-bold">{focus.slice(0, 7)}</h2>
          <div className="grid grid-cols-7 text-center text-xs font-bold">
            {t.weekdays.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          {monthGrid(focus).map((week) => (
            <div key={week[0]} className="grid grid-cols-7">
              {week.map((day) => (
                <DayCell
                  key={day}
                  day={day}
                  today={today}
                  inMonth={day.slice(0, 7) === focus.slice(0, 7)}
                  orders={byDate.get(day) ?? []}
                  t={t}
                  showGuests={prefs.columns.guests}
                  onOpen={setOpen}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {data && focus && prefs.view === "week" && (
        <div data-testid="next-week">
          <div className="grid grid-cols-7 text-center text-xs font-bold">
            {weekDays(focus).map((d, i) => (
              <div key={d}>
                {t.weekdays[i]} <span className="tabular-nums">{d.slice(5)}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {weekDays(focus).map((day) => (
              <DayCell
                key={day}
                day={day}
                today={today}
                inMonth
                tall
                orders={byDate.get(day) ?? []}
                t={t}
                showGuests={prefs.columns.guests}
                onOpen={setOpen}
              />
            ))}
          </div>
        </div>
      )}

      {data && prefs.view === "list" && (
        <ul className="flex flex-col gap-2" data-testid="next-list">
          {data.orders.map((o) => (
            <li key={o.id_tail}>
              <OrderRow order={o} t={t} columns={prefs.columns} onOpen={setOpen} />
            </li>
          ))}
        </ul>
      )}

      {off && (
        <p className="font-semibold text-neutral-700" data-testid="next-off">
          {t.off}
        </p>
      )}
      {data && !off && data.orders.length === 0 && (
        <p className="font-semibold text-neutral-700" data-testid="next-empty">
          {t.empty}
        </p>
      )}

      {open && (
        <div
          className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
          onClick={() => setOpen(null)}
        >
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <OrderDetail order={open} columns={prefs.columns} t={t} onClose={() => setOpen(null)} />
          </div>
        </div>
      )}
    </main>
  );
}
