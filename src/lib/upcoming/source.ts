import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/constants";
import { fenceStripPayload, type StripOrder, type UpcomingOrder } from "./fence";

/**
 * Where SQUARE NEXT gets its orders. One interface, three sources:
 * - off (default, NEXT_SOURCE unset): no orders, and the floor link stays hidden.
 * - fixture (NEXT_SOURCE=fixture): the three real C1 kitchen records in
 *   fixtures/square-next. Test switch only.
 * - sheet (NEXT_SOURCE=sheet): an outbound GET to C1's read-only link, every
 *   5 minutes. Fail-closed unless both the URL and the key are set.
 * No Square token is read here. The host never talks to Square.
 */

export type SourceKind = "off" | "fixture" | "sheet";

export type UpcomingSnapshot = {
  source: SourceKind;
  orders: UpcomingOrder[];
  heldBack: number;
  /** When the source was last read successfully (ISO), or null if never. */
  fetchedAt: string | null;
  /** True when the last read failed and the orders shown are older. */
  stale: boolean;
};

/** Same snapshot as the general read, with the strip-only first name on each order. */
export type StripSnapshot = Omit<UpcomingSnapshot, "orders"> & {
  orders: StripOrder[];
};

export interface UpcomingSource {
  readonly kind: SourceKind;
  /** Nameless orders. Próximos and every non-strip caller use this. */
  load(now?: Date): Promise<UpcomingSnapshot>;
  /** Cocina and caja strip. Same read as `load`, plus a sanitized first name. */
  loadStrip(now?: Date): Promise<StripSnapshot>;
}

/** Drop the strip name so a general response cannot carry it. */
function asKitchen(order: StripOrder): UpcomingOrder {
  return {
    id_tail: order.id_tail,
    fulfill_type: order.fulfill_type,
    event_date: order.event_date,
    event_time: order.event_time,
    ready_time: order.ready_time,
    guests: order.guests,
    lines: order.lines.map((line) => ({
      item_name: line.item_name,
      variation: line.variation,
      modifiers: line.modifiers,
      qty: line.qty,
    })),
  };
}

function kitchenSnapshot(snap: StripSnapshot): UpcomingSnapshot {
  return { ...snap, orders: snap.orders.map(asKitchen) };
}

export const SHEET_REFRESH_MS = 5 * 60 * 1000;
/** One C1 read may run this long before the last good copy is kept. */
export const SHEET_TIMEOUT_MS = 60_000;

/** Today in the restaurant's clock. */
export function chicagoToday(now: Date = new Date()): string {
  return formatInTimeZone(now, TIMEZONE, "yyyy-MM-dd");
}

/** Orders dated today or later (Chicago), soonest first. */
export function upcomingOnly<T extends UpcomingOrder>(orders: T[], today: string): T[] {
  return orders
    .filter((o) => o.event_date >= today)
    .sort((a, b) =>
      a.event_date === b.event_date
        ? a.event_time.localeCompare(b.event_time)
        : a.event_date.localeCompare(b.event_date),
    );
}

function offSnapshot(): StripSnapshot {
  return { source: "off", orders: [], heldBack: 0, fetchedAt: null, stale: false };
}

export class OffSource implements UpcomingSource {
  readonly kind = "off" as const;
  async load(): Promise<UpcomingSnapshot> {
    return offSnapshot();
  }
  async loadStrip(): Promise<StripSnapshot> {
    return offSnapshot();
  }
}

export class FixtureSource implements UpcomingSource {
  readonly kind = "fixture" as const;
  constructor(
    private readonly file = path.join(process.cwd(), "fixtures", "square-next", "orders.json"),
  ) {}

  async load(now: Date = new Date()): Promise<UpcomingSnapshot> {
    return kitchenSnapshot(await this.read(now));
  }

  async loadStrip(now: Date = new Date()): Promise<StripSnapshot> {
    return this.read(now);
  }

  private async read(now: Date): Promise<StripSnapshot> {
    const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
    const { orders, heldBack } = fenceStripPayload(raw);
    return {
      source: this.kind,
      orders: upcomingOnly(orders, chicagoToday(now)),
      heldBack,
      fetchedAt: now.toISOString(),
      stale: false,
    };
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type C1Outcome = "ok" | "timeout" | "no-orders" | `non-200 ${number}`;

/** One C1 attempt. The line never includes the URL, the key, or an order value. */
function logC1Read(startedMs: number, outcome: C1Outcome, orders: number): void {
  const duration = Date.now() - startedMs;
  console.info(
    `c1-read start=${new Date(startedMs).toISOString()} outcome=${outcome} duration_ms=${duration} orders=${orders}`,
  );
}

/**
 * C1's read-only link. Apps Script doGet only sees query parameters, so the
 * key rides as `key=`. The URL with the key is never logged or returned.
 *
 * `lastTry` is the wall clock when the attempt settles, not when it starts.
 * A failed attempt arms one follow-up, so the next board request inside five
 * minutes retries once. That one retry is the only extra read while five
 * minutes have not passed, including when there is still no last good copy.
 * Overlapping loads share the in-flight attempt.
 */
export class SheetSource implements UpcomingSource {
  readonly kind = "sheet" as const;
  private last: { orders: StripOrder[]; heldBack: number; at: number } | null = null;
  private lastTry = 0;
  /** One extra read after a failed attempt, before the five-minute cadence. */
  private retryPending = false;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async load(now: Date = new Date()): Promise<UpcomingSnapshot> {
    await this.refresh();
    return kitchenSnapshot(this.snapshot(now));
  }

  async loadStrip(now: Date = new Date()): Promise<StripSnapshot> {
    await this.refresh();
    return this.snapshot(now);
  }

  private snapshot(now: Date): StripSnapshot {
    const stale = !this.last || this.last.at !== this.lastTry;
    return {
      source: this.kind,
      orders: this.last ? upcomingOnly(this.last.orders, chicagoToday(now)) : [],
      heldBack: this.last?.heldBack ?? 0,
      fetchedAt: this.last ? new Date(this.last.at).toISOString() : null,
      stale,
    };
  }

  private async refresh(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    const wall = Date.now();
    const cadenceDue = this.lastTry === 0 || wall - this.lastTry >= SHEET_REFRESH_MS;
    if (!cadenceDue && !this.retryPending) return;
    const immediate = !cadenceDue && this.retryPending;
    this.retryPending = false;
    const run = this.attempt(immediate);
    this.inflight = run.finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async attempt(immediate: boolean): Promise<void> {
    const started = Date.now();
    let outcome: C1Outcome = "timeout";
    let count = 0;
    try {
      const target = new URL(this.url);
      target.searchParams.set("key", this.key);
      const res = await this.fetchImpl(target.toString(), {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(SHEET_TIMEOUT_MS),
      });
      if (!res.ok) {
        outcome = `non-200 ${res.status}`;
      } else {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        // A 200 without an orders list (a wrong key, an Apps Script error page)
        // is a failed read, not an empty calendar.
        const list =
          body && typeof body === "object" && Array.isArray((body as { orders?: unknown }).orders)
            ? (body as { orders: unknown[] }).orders
            : null;
        if (!list) {
          outcome = "no-orders";
        } else {
          count = list.length;
          const { orders, heldBack } = fenceStripPayload(body);
          // `at` is replaced with the settle clock in `finally`, same value as `lastTry`.
          this.last = { orders, heldBack, at: 0 };
          outcome = "ok";
        }
      }
    } catch {
      // No HTTP answer. Keep the last good read; the page shows it as stale.
      outcome = "timeout";
    } finally {
      const settled = Date.now();
      if (outcome === "ok" && this.last) this.last.at = settled;
      this.lastTry = settled;
      this.retryPending = outcome !== "ok" && !immediate;
      logC1Read(started, outcome, count);
    }
  }
}

let cached: UpcomingSource | null = null;

/**
 * Off unless the host names a source. NEXT_SOURCE=sheet needs both
 * C1_NEXT_URL and C1_NEXT_KEY; a half-configured sheet source fails closed to
 * no orders. Any other value is off.
 */
export function sourceFromEnv(env: NodeJS.ProcessEnv = process.env): UpcomingSource {
  if (env.NEXT_SOURCE === "fixture") return new FixtureSource();
  if (env.NEXT_SOURCE !== "sheet") return new OffSource();
  const url = env.C1_NEXT_URL?.trim() ?? "";
  const key = env.C1_NEXT_KEY?.trim() ?? "";
  if (!/^https:\/\//.test(url) || !key) return new SheetSource("https://invalid.invalid/", "", () =>
    Promise.reject(new Error("C1 link not configured")),
  );
  return new SheetSource(url, key);
}

/** The floor shows its link to /next only when a source is named. Reads no orders. */
export function nextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXT_SOURCE === "fixture" || env.NEXT_SOURCE === "sheet";
}

export function getUpcomingSource(): UpcomingSource {
  if (!cached) cached = sourceFromEnv();
  return cached;
}
