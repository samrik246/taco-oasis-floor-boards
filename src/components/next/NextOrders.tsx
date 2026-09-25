"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { UpcomingOrder } from "@/lib/upcoming/fence";
import type { UpcomingSnapshot } from "@/lib/upcoming/source";
import {
  addDays,
  addMonths,
  groupByDate,
  monthGrid,
  weekDays,
} from "@/lib/upcoming/calendar";
import { NEXT_COPY, type NextCopy } from "./next-copy";
import { dayHeading, monthTitle, time12 } from "./format";
import { OrderDetail } from "./OrderDetail";
import { OrderCard } from "./parts";
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

const BTN =
  "inline-flex min-h-14 items-center justify-center gap-2 rounded-lg border-2 border-neutral-900 px-4 text-[22px] font-bold";

/**
 * A month cell holds the day number and the order count only: the guest
 * sentence does not fit a month column at 20px. Tapping a day with orders
 * opens that day in the list.
 */
export function MonthCell({
  day,
  today,
  inMonth,
  count,
  t,
  onOpenDay,
}: {
  day: string;
  today: string;
  inMonth: boolean;
  count: number;
  t: NextCopy;
  onOpenDay: (day: string) => void;
}) {
  const body = (
    <>
      <span className="text-[22px] font-black tabular-nums">{Number(day.slice(8))}</span>
      {count > 0 && (
        <span className="rounded-md bg-amber-200 px-2 text-[20px] font-black text-neutral-900">
          {t.orderCount(count)}
        </span>
      )}
    </>
  );
  const cls = `flex min-h-24 flex-col items-start gap-1 border border-neutral-300 p-2 text-left ${
    inMonth ? "bg-white text-neutral-900" : "bg-neutral-100 text-neutral-600"
  } ${day === today ? "outline outline-4 -outline-offset-4 outline-red-700" : ""}`;
  return count > 0 ? (
    <button type="button" className={cls} onClick={() => onOpenDay(day)} data-testid={`next-month-day-${day}`}>
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={`next-month-day-${day}`}>
      {body}
    </div>
  );
}

export function NextOrders() {
  const [prefs, setPrefs] = useState<NextPrefs>(DEFAULT_PREFS);
  const [data, setData] = useState<Payload | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [open, setOpen] = useState<UpcomingOrder | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const scrollToDay = useRef<string | null>(null);

  const t = NEXT_COPY[prefs.locale];
  const locale = prefs.locale;

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

  // The detail sheet owns one history entry. Back, Cerrar and Volver all close
  // it by popping that entry once; this is the only popstate listener here.
  useEffect(() => {
    const onPop = () => setOpen(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openOrder = (o: UpcomingOrder) => {
    window.history.pushState({ nextSheet: true }, "");
    setOpen(o);
  };
  const closeSheet = () => window.history.back();

  // After a month tap switches to the list, bring that day's heading up.
  useEffect(() => {
    const day = scrollToDay.current;
    if (!day || prefs.view !== "list") return;
    scrollToDay.current = null;
    document.getElementById(`next-day-${day}`)?.scrollIntoView({ block: "start" });
  });

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

  const openDay = (day: string) => {
    scrollToDay.current = day;
    update({ ...prefs, view: "list" });
  };

  const views: NextView[] = ["list", "week", "month"];
  const updatedAt =
    fetchedMs == null
      ? t.never
      : time12(
          new Date(fetchedMs).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "America/Chicago",
          }),
        );

  const dayBlock = (day: string, orders: UpcomingOrder[]) => (
    <section key={day} className="flex flex-col gap-2" data-testid={`next-day-${day}`}>
      <h2
        id={`next-day-${day}`}
        className="sticky top-0 z-10 border-b-2 border-neutral-900 bg-neutral-50 py-2 text-[26px] font-black"
      >
        {dayHeading(day, today, locale)}
      </h2>
      {orders.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {orders.map((o, i) => (
            <li key={o.id_tail}>
              <OrderCard
                order={o}
                t={t}
                locale={locale}
                today={today}
                columns={prefs.columns}
                zebra={i % 2 === 1}
                onOpen={openOrder}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-2 text-[22px] text-neutral-700">{t.noOrdersDay}</p>
      )}
    </section>
  );

  return (
    <main
      className="flex min-h-dvh flex-col gap-4 bg-neutral-50 p-3 text-[22px] text-neutral-900 sm:p-5"
      style={{ colorScheme: "light" }}
      data-testid="next-app"
    >
      <header className="flex flex-col gap-3 border-b-2 border-neutral-900 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="mr-2 text-[28px] font-black">{t.title}</h1>
          {data?.source === "fixture" && (
            <span
              className="rounded-md bg-neutral-900 px-3 py-1 text-[20px] font-bold text-white"
              data-testid="next-test-data"
            >
              {t.testData}
            </span>
          )}
          <span className="text-[20px] font-semibold tabular-nums text-neutral-700 sm:ml-auto" data-testid="next-updated">
            {t.updated}: {updatedAt}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => update({ ...prefs, view: v })}
              className={`${BTN} min-w-32 ${prefs.view === v ? "bg-neutral-900 text-white" : "bg-white"}`}
              aria-pressed={prefs.view === v}
              data-testid={`next-view-${v}`}
            >
              {t[v]}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={`${BTN} bg-white disabled:opacity-50`}
            data-testid="next-refresh"
          >
            <RefreshCw aria-hidden className="size-6" />
            {t.refresh}
          </button>
          <button
            type="button"
            onClick={() => setOptionsOpen((o) => !o)}
            className={`${BTN} ${optionsOpen ? "bg-neutral-900 text-white" : "bg-white"}`}
            aria-expanded={optionsOpen}
            data-testid="next-options"
          >
            <SlidersHorizontal aria-hidden className="size-6" />
            {t.options}
          </button>
          <button
            type="button"
            onClick={() => update({ ...prefs, locale: locale === "es" ? "en" : "es" })}
            className={`${BTN} bg-white`}
            data-testid="next-locale"
          >
            {locale === "es" ? "English" : "Español"}
          </button>
          <Link href="/?board=cocina" className={`${BTN} bg-white underline`} data-testid="next-back">
            {t.back}
          </Link>
        </div>
        {optionsOpen && (
          <fieldset
            className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border-2 border-neutral-300 bg-white p-3"
            data-testid="next-columns"
          >
            <legend className="px-1 text-[22px] font-bold">{t.columns}</legend>
            {NEXT_COLUMNS.map((c) => (
              <label key={c} className="flex min-h-14 items-center gap-3 text-[22px] font-semibold">
                <input
                  type="checkbox"
                  className="size-7"
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
        )}
      </header>

      {showStale && (
        <p className="rounded-lg border-2 border-red-700 bg-red-50 p-3 text-[24px] font-bold text-red-800" data-testid="next-stale">
          {t.stale}
        </p>
      )}
      {data && data.heldBack > 0 && (
        <p className="rounded-lg border-2 border-amber-700 bg-amber-50 p-3 text-[24px] font-bold text-amber-900" data-testid="next-held">
          {t.heldBack(data.heldBack)}
        </p>
      )}

      {data && !off && focus && prefs.view !== "list" && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${BTN} bg-white`} onClick={() => step(-1)} data-testid="next-prev">
            <ChevronLeft aria-hidden className="size-7" />
            {t.prev}
          </button>
          <button type="button" className={`${BTN} bg-white`} onClick={() => setAnchor(today || null)} data-testid="next-today">
            {t.today}
          </button>
          <button type="button" className={`${BTN} bg-white`} onClick={() => step(1)} data-testid="next-next">
            {t.next}
            <ChevronRight aria-hidden className="size-7" />
          </button>
        </div>
      )}

      {data && !off && prefs.view === "list" && data.orders.length > 0 && (
        <div className="flex flex-col gap-4" data-testid="next-list">
          {[...byDate.entries()].map(([day, orders]) => dayBlock(day, orders))}
        </div>
      )}

      {data && !off && focus && prefs.view === "week" && (
        <div className="flex flex-col gap-4" data-testid="next-week">
          {weekDays(focus).map((day) => dayBlock(day, byDate.get(day) ?? []))}
        </div>
      )}

      {data && !off && focus && prefs.view === "month" && (
        <div data-testid="next-month">
          <h2 className="mb-2 text-[26px] font-black">{monthTitle(focus, locale)}</h2>
          <div className="grid grid-cols-7 text-center text-[20px] font-bold">
            {t.weekdays.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          {monthGrid(focus).map((week) => (
            <div key={week[0]} className="grid grid-cols-7">
              {week.map((day) => (
                <MonthCell
                  key={day}
                  day={day}
                  today={today}
                  inMonth={day.slice(0, 7) === focus.slice(0, 7)}
                  count={byDate.get(day)?.length ?? 0}
                  t={t}
                  onOpenDay={openDay}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {off && (
        <p className="text-[28px] font-bold text-neutral-800" data-testid="next-off">
          {t.off}
        </p>
      )}
      {data && !off && data.orders.length === 0 && prefs.view === "list" && (
        <div className="flex flex-col gap-1" data-testid="next-empty">
          <p className="text-[28px] font-bold text-neutral-800">{t.empty}</p>
          <p className="text-[22px] text-neutral-700">{t.checksEvery}</p>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-30 overflow-y-auto bg-white" data-testid="next-sheet">
          <OrderDetail
            order={open}
            columns={prefs.columns}
            t={t}
            locale={locale}
            today={today}
            onClose={closeSheet}
          />
        </div>
      )}
    </main>
  );
}
