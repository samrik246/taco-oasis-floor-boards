/**
 * C3 regular orders fence. The feed's snapshot passes through here before any
 * route or page sees it. Only the fields below survive; any other key drops.
 *
 * Unlike the T4G fence, one bad line note does not hold the whole order back:
 * a note, modifier, item name or variation that looks like a name label,
 * phone, email, street or money is blanked whole and counted. Never shown in
 * part. The shapes are the T4G `forbiddenText`, reused as is.
 */

import { acceptFirstName, forbiddenText } from "@/lib/upcoming/fence";

export const REGULAR_FIELDS = [
  "source",
  "id_tail",
  "order_time",
  "ready_time",
  "fulfillment",
  "first_name",
  "state",
  "items",
] as const;

export const REGULAR_ITEM_FIELDS = ["name", "qty", "variation", "modifiers", "note"] as const;

export type RegularSourceName = "square_online" | "lavu";
export type RegularState = "OPEN" | "COMPLETED" | "CANCELED";
export type RegularFulfillment = "PICKUP" | "DELIVERY";

export type RegularItem = {
  name: string;
  qty: number;
  variation: string;
  modifiers: string[];
  note: string;
};

export type RegularOrder = {
  source: RegularSourceName;
  id_tail: string;
  /** ISO with offset, as the feed wrote it. */
  order_time: string;
  ready_time: string | null;
  fulfillment: RegularFulfillment;
  first_name: string;
  state: RegularState;
  items: RegularItem[];
};

export type RegularFenceResult = {
  orders: RegularOrder[];
  /** Orders dropped whole for a bad shape. Count only. */
  heldBack: number;
  /** Text fields blanked by the guard. Count only. */
  textBlanked: number;
};

const SOURCES = new Set<RegularSourceName>(["square_online", "lavu"]);
const STATES = new Set<RegularState>(["OPEN", "COMPLETED", "CANCELED"]);
const TAIL = /^[A-Za-z0-9]{4,8}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT = 400;
const MAX_ITEMS = 200;
const MAX_MODIFIERS = 50;

function isoOk(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));
}

type Counter = { blanked: number };

/** Text through the guard. Unfit text becomes "" and is counted. */
function guardText(value: unknown, count: Counter): string {
  if (value == null) return "";
  if (typeof value !== "string") {
    count.blanked += 1;
    return "";
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length > MAX_TEXT || forbiddenText(text)) {
    count.blanked += 1;
    return "";
  }
  return text;
}

function fenceItem(raw: unknown, count: Counter): RegularItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const qty = typeof r.qty === "number" ? r.qty : Number.NaN;
  if (!Number.isFinite(qty) || qty < 0 || qty > 10000) return null;
  const modifiers: string[] = [];
  if (Array.isArray(r.modifiers)) {
    for (const m of r.modifiers.slice(0, MAX_MODIFIERS)) {
      const text = guardText(m, count);
      if (text) modifiers.push(text);
    }
  }
  return {
    name: guardText(r.name, count),
    qty,
    variation: guardText(r.variation, count),
    modifiers,
    note: guardText(r.note, count),
  };
}

/** One order through the allow-list, or null when its shape is wrong. */
export function fenceRegularOrder(raw: unknown, count: Counter = { blanked: 0 }): RegularOrder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.source !== "string" || !SOURCES.has(r.source as RegularSourceName)) return null;
  if (typeof r.id_tail !== "string" || !TAIL.test(r.id_tail)) return null;
  if (!isoOk(r.order_time)) return null;
  if (r.ready_time != null && !isoOk(r.ready_time)) return null;
  if (r.fulfillment !== "PICKUP" && r.fulfillment !== "DELIVERY") return null;
  if (typeof r.state !== "string" || !STATES.has(r.state as RegularState)) return null;
  if (!Array.isArray(r.items) || r.items.length > MAX_ITEMS) return null;
  const local: Counter = { blanked: 0 };
  const items: RegularItem[] = [];
  for (const rawItem of r.items) {
    const item = fenceItem(rawItem, local);
    if (!item) return null;
    items.push(item);
  }
  count.blanked += local.blanked;
  return {
    source: r.source as RegularSourceName,
    id_tail: r.id_tail,
    order_time: r.order_time,
    ready_time: (r.ready_time as string | null | undefined) ?? null,
    fulfillment: r.fulfillment,
    first_name: acceptFirstName(r.first_name),
    state: r.state as RegularState,
    items,
  };
}

/** The whole snapshot's order list through the fence. */
export function fenceRegularPayload(payload: unknown): RegularFenceResult {
  const list =
    payload && typeof payload === "object" && Array.isArray((payload as { orders?: unknown }).orders)
      ? (payload as { orders: unknown[] }).orders
      : null;
  if (!list) return { orders: [], heldBack: 0, textBlanked: 0 };
  const count: Counter = { blanked: 0 };
  const orders: RegularOrder[] = [];
  let heldBack = 0;
  for (const raw of list) {
    const order = fenceRegularOrder(raw, count);
    if (order) orders.push(order);
    else heldBack += 1;
  }
  return { orders, heldBack, textBlanked: count.blanked };
}
