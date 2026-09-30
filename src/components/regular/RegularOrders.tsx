"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Locale } from "@/lib/i18n";
import { chicagoClock } from "@/lib/regular/clock";
import type { RegularOrder } from "@/lib/regular/fence";
import type { RegularSnapshot } from "@/lib/regular/source";
import { readPrefs, savePrefs } from "@/components/next/prefs";
import { REGULAR_COPY, type RegularCopy } from "./regular-copy";

type Payload = RegularSnapshot & { today: string };

/** The feed polls Square every 60 s; the page reads the snapshot twice as often. */
export const REGULAR_POLL_MS = 30_000;

const BTN =
  "inline-flex min-h-14 items-center justify-center gap-2 rounded-lg border-2 border-neutral-900 px-4 text-[22px] font-bold";

/** The banner that replaces the list when the feed is not fresh. */
export function staleLine(t: RegularCopy, lastGoodClock: string | null): string {
  return lastGoodClock ? t.staleSince(lastGoodClock) : t.staleNever;
}

export function RegularCard({ order, t, zebra }: { order: RegularOrder; t: RegularCopy; zebra: boolean }) {
  const done = order.state !== "OPEN";
  return (
    <article
      className={`flex flex-col gap-2 rounded-lg border-2 border-neutral-900 p-3 ${
        zebra ? "bg-neutral-100" : "bg-white"
      } ${done ? "opacity-70" : ""}`}
      data-testid={`regular-card-${order.id_tail}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[30px] font-black tabular-nums">
          {order.ready_time ? chicagoClock(order.ready_time) : "—"}
        </span>
        <span className="rounded-md bg-neutral-900 px-2 text-[22px] font-black text-white">
          {t.fulfillment[order.fulfillment]}
        </span>
        <span className="text-[26px] font-black" data-testid="regular-name">
          {order.first_name || t.noName}
        </span>
        <span className="text-[22px] font-semibold tabular-nums text-neutral-700">#{order.id_tail}</span>
        <span
          className={`text-[22px] font-bold ${order.state === "CANCELED" ? "text-red-800" : "text-neutral-800"}`}
          data-testid="regular-state"
        >
          {t.state[order.state]}
        </span>
        <span className="text-[20px] text-neutral-700 sm:ml-auto">
          {t.ordered} {chicagoClock(order.order_time)}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {order.items.map((item, i) => (
          <li key={i} className="text-[22px]">
            <span className="font-black tabular-nums">{item.qty} ×</span>{" "}
            <span className="font-bold">{item.name || "—"}</span>
            {item.variation && <span> ({item.variation})</span>}
            {item.modifiers.length > 0 && (
              <span className="block pl-8 text-[20px] text-neutral-800">{item.modifiers.join(", ")}</span>
            )}
            {item.note && <span className="block pl-8 text-[20px] italic text-neutral-800">“{item.note}”</span>}
          </li>
        ))}
      </ul>
    </article>
  );
}

export function RegularOrders() {
  const [locale, setLocale] = useState<Locale>("es");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const t = REGULAR_COPY[locale];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/upcoming/regular", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as Payload);
    } catch {
      // The boards server did not answer: the last list is no longer trusted.
      setData((d) => (d ? { ...d, fresh: false, orders: [] } : d));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Tablet storage is only readable after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocale(readPrefs().locale);
    void load();
    const id = window.setInterval(() => void load(), REGULAR_POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const toggleLocale = () => {
    const next: Locale = locale === "es" ? "en" : "es";
    setLocale(next);
    savePrefs({ ...readPrefs(), locale: next });
  };

  const off = data?.source === "off";

  return (
    <main
      className="flex min-h-dvh flex-col gap-4 bg-neutral-50 p-3 text-[22px] text-neutral-900 sm:p-5"
      style={{ colorScheme: "light" }}
      data-testid="regular-app"
    >
      <header className="flex flex-col gap-3 border-b-2 border-neutral-900 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="mr-2 text-[28px] font-black">{t.title}</h1>
          {data?.fresh && data.lastGoodClock && (
            <span className="text-[20px] font-semibold tabular-nums text-neutral-700 sm:ml-auto" data-testid="regular-updated">
              {t.updated}: {data.lastGoodClock}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={`${BTN} bg-white disabled:opacity-50`}
            data-testid="regular-refresh"
          >
            <RefreshCw aria-hidden className="size-6" />
            {locale === "es" ? "Actualizar" : "Refresh"}
          </button>
          <button type="button" onClick={toggleLocale} className={`${BTN} bg-white`} data-testid="regular-locale">
            {locale === "es" ? "English" : "Español"}
          </button>
          <Link href="/next" className={`${BTN} bg-white underline`} data-testid="regular-back">
            {t.back}
          </Link>
          <Link href="/?board=cocina" className={`${BTN} bg-white underline`} data-testid="regular-board">
            {t.board}
          </Link>
        </div>
      </header>

      {off && (
        <p className="text-[28px] font-bold text-neutral-800" data-testid="regular-off">
          {t.off}
        </p>
      )}
      {data && !off && !data.fresh && (
        <p
          className="rounded-lg border-2 border-red-700 bg-red-50 p-3 text-[28px] font-black text-red-800"
          data-testid="regular-stale"
        >
          {staleLine(t, data.lastGoodClock)}
        </p>
      )}
      {data && data.fresh && data.heldBack > 0 && (
        <p className="rounded-lg border-2 border-amber-700 bg-amber-50 p-3 text-[24px] font-bold text-amber-900" data-testid="regular-held">
          {t.heldBack(data.heldBack)}
        </p>
      )}
      {data && data.fresh && data.orders.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="regular-list">
          {data.orders.map((o, i) => (
            <li key={`${o.source}-${o.id_tail}`}>
              <RegularCard order={o} t={t} zebra={i % 2 === 1} />
            </li>
          ))}
        </ul>
      )}
      {data && data.fresh && data.orders.length === 0 && (
        <p className="text-[28px] font-bold text-neutral-800" data-testid="regular-empty">
          {t.empty}
        </p>
      )}
    </main>
  );
}
