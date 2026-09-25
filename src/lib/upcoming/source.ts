import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/constants";
import { fencePayload, type UpcomingOrder } from "./fence";

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

export interface UpcomingSource {
  readonly kind: SourceKind;
  load(now?: Date): Promise<UpcomingSnapshot>;
}

export const SHEET_REFRESH_MS = 5 * 60 * 1000;
const SHEET_TIMEOUT_MS = 20_000;

/** Today in the restaurant's clock. */
export function chicagoToday(now: Date = new Date()): string {
  return formatInTimeZone(now, TIMEZONE, "yyyy-MM-dd");
}

/** Orders dated today or later (Chicago), soonest first. */
export function upcomingOnly(orders: UpcomingOrder[], today: string): UpcomingOrder[] {
  return orders
    .filter((o) => o.event_date >= today)
    .sort((a, b) =>
      a.event_date === b.event_date
        ? a.event_time.localeCompare(b.event_time)
        : a.event_date.localeCompare(b.event_date),
    );
}

export class OffSource implements UpcomingSource {
  readonly kind = "off" as const;
  async load(): Promise<UpcomingSnapshot> {
    return { source: this.kind, orders: [], heldBack: 0, fetchedAt: null, stale: false };
  }
}

export class FixtureSource implements UpcomingSource {
  readonly kind = "fixture" as const;
  constructor(
    private readonly file = path.join(process.cwd(), "fixtures", "square-next", "orders.json"),
  ) {}

  async load(now: Date = new Date()): Promise<UpcomingSnapshot> {
    const raw = JSON.parse(await readFile(this.file, "utf8")) as unknown;
    const { orders, heldBack } = fencePayload(raw);
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

/**
 * C1's read-only link. Apps Script doGet only sees query parameters, so the
 * key rides as `key=`. The URL with the key is never logged or returned.
 */
export class SheetSource implements UpcomingSource {
  readonly kind = "sheet" as const;
  private last: { orders: UpcomingOrder[]; heldBack: number; at: number } | null = null;
  private lastTry = 0;

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async load(now: Date = new Date()): Promise<UpcomingSnapshot> {
    const t = now.getTime();
    if (t - this.lastTry >= SHEET_REFRESH_MS || !this.last) {
      this.lastTry = t;
      try {
        const target = new URL(this.url);
        target.searchParams.set("key", this.key);
        const res = await this.fetchImpl(target.toString(), {
          method: "GET",
          redirect: "follow",
          cache: "no-store",
          signal: AbortSignal.timeout(SHEET_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`C1 link answered ${res.status}`);
        const body = (await res.json()) as unknown;
        // A 200 without an orders list (a wrong key, an Apps Script error page)
        // is a failed read, not an empty calendar.
        if (!body || typeof body !== "object" || !Array.isArray((body as { orders?: unknown }).orders)) {
          throw new Error("C1 link sent no orders list");
        }
        const { orders, heldBack } = fencePayload(body);
        this.last = { orders, heldBack, at: t };
      } catch {
        // Keep the last good read; the page shows it as stale.
      }
    }
    const stale = !this.last || this.last.at !== this.lastTry;
    return {
      source: this.kind,
      orders: this.last ? upcomingOnly(this.last.orders, chicagoToday(now)) : [],
      heldBack: this.last?.heldBack ?? 0,
      fetchedAt: this.last ? new Date(this.last.at).toISOString() : null,
      stale,
    };
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
