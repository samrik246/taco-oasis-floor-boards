"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import { NEXT_POLL_MS, readIsStale } from "@/lib/upcoming/cadence";
import { fencePayload, type UpcomingOrder } from "@/lib/upcoming/fence";
import type { Locale } from "@/lib/i18n";
import { NEXT_COPY } from "@/components/next/next-copy";
import { stripOrderLabel } from "@/components/next/strip-label";
import { OrderDetail } from "@/components/next/OrderDetail";
import { FulfillWord, fulfillBar } from "@/components/next/parts";
import { DEFAULT_PREFS } from "@/components/next/prefs";

export type StripSnap =
  | { kind: "off" }
  | {
      kind: "on";
      orders: UpcomingOrder[];
      today: string;
      stale: boolean;
      fetchedAt: string | null;
    };

/** Orders for the day on the board, soonest event_time first, then tail. */
export function ordersOnDay(orders: UpcomingOrder[], date: string): UpcomingOrder[] {
  return orders
    .filter((order) => order.event_date === date)
    .sort(
      (a, b) => a.event_time.localeCompare(b.event_time) || a.id_tail.localeCompare(b.id_tail),
    );
}

/**
 * One GET /api/upcoming result.
 * Off paints nothing. A failed read keeps the last good list and marks it stale.
 * A failure before any good read is a stale line with no cells.
 */
export function reduceStripLoad(
  prev: StripSnap | null,
  result: { ok: true; body: unknown } | { ok: false },
): StripSnap {
  if (!result.ok || result.body == null || typeof result.body !== "object") {
    if (prev?.kind === "on") return { ...prev, stale: true };
    if (prev?.kind === "off") return prev;
    return { kind: "on", orders: [], today: "", stale: true, fetchedAt: null };
  }
  const body = result.body as {
    source?: unknown;
    today?: unknown;
    stale?: unknown;
    fetchedAt?: unknown;
  };
  if (body.source !== "fixture" && body.source !== "sheet") {
    return { kind: "off" };
  }
  return {
    kind: "on",
    orders: fencePayload(body).orders,
    today: typeof body.today === "string" ? body.today : "",
    stale: body.stale === true,
    fetchedAt: typeof body.fetchedAt === "string" ? body.fetchedAt : null,
  };
}

/** A strip failure draws nothing, so Horario under it still draws. */
export class T4gGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export function T4gStripView({
  snap,
  date,
  locale,
  nowMs,
  onOpen,
}: {
  snap: StripSnap;
  date: string;
  locale: Locale;
  nowMs: number;
  onOpen?: (order: UpcomingOrder) => void;
}) {
  if (snap.kind === "off") return null;
  const t = NEXT_COPY[locale];
  const orders = ordersOnDay(snap.orders, date);
  const showStale = readIsStale(snap.stale, snap.fetchedAt, nowMs);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="t4g-strip">
      {showStale && (
        <p className="text-xs font-bold text-red-800" data-testid="t4g-strip-stale">
          {t.stale}
        </p>
      )}
      {!showStale && orders.length === 0 && (
        <p className="text-xs font-semibold text-neutral-700" data-testid="t4g-strip-empty">
          {date === snap.today ? t.t4gEmptyToday : t.t4gEmptyDay}
        </p>
      )}
      {orders.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {orders.map((order) => (
            <button
              key={order.id_tail}
              type="button"
              onClick={() => onOpen?.(order)}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-md border-2 border-l-8 border-neutral-300 bg-white px-2 py-1 text-left text-sm font-semibold text-neutral-900 ${fulfillBar(order.fulfill_type)}`}
              data-testid="t4g-order"
              data-fulfill={order.fulfill_type}
            >
              <span data-testid="t4g-order-label">{stripOrderLabel(order, t)}</span>
              <FulfillWord type={order.fulfill_type} t={t} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function T4gStripLive({ date, locale }: { date: string; locale: Locale }) {
  const [snap, setSnap] = useState<StripSnap | null>(null);
  const [open, setOpen] = useState<UpcomingOrder | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const t = NEXT_COPY[locale];

  useEffect(() => {
    let stopped = false;
    let timer = 0;

    const load = async () => {
      if (stopped) return;
      setNowMs(Date.now());
      try {
        const res = await fetch("/api/upcoming", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body: unknown = await res.json();
        if (stopped) return;
        // Off is read from this result, not from inside the setSnap updater.
        // React may run that updater later, and the interval would keep firing.
        const probed = reduceStripLoad(null, { ok: true, body });
        if (probed.kind === "off") {
          stopped = true;
          window.clearInterval(timer);
          setSnap(probed);
          return;
        }
        setSnap((prev) => reduceStripLoad(prev, { ok: true, body }));
      } catch {
        if (!stopped) setSnap((prev) => reduceStripLoad(prev, { ok: false }));
      }
    };

    timer = window.setInterval(() => void load(), NEXT_POLL_MS);
    void load();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!snap || snap.kind === "off") return null;
  return (
    <>
      <T4gStripView
        snap={snap}
        date={date}
        locale={locale}
        nowMs={nowMs}
        onOpen={setOpen}
      />
      {open && (
        <div className="fixed inset-0 z-30 overflow-y-auto bg-white" data-testid="t4g-detail">
          <OrderDetail
            order={open}
            columns={DEFAULT_PREFS.columns}
            t={t}
            locale={locale}
            today={snap.today || open.event_date}
            surface="board"
            onClose={() => setOpen(null)}
          />
        </div>
      )}
    </>
  );
}

/** T4G orders for the day on screen. Reads only GET /api/upcoming. */
export function T4gStrip({ date, locale }: { date: string; locale: Locale }) {
  return (
    <T4gGuard>
      <T4gStripLive date={date} locale={locale} />
    </T4gGuard>
  );
}
