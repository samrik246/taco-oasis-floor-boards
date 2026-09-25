/**
 * SQUARE NEXT privacy fence (23A). Every order that reaches the page passes
 * through here. Only the kitchen-record fields below survive; any other key
 * the source sends is dropped. An order whose text looks like a name, phone,
 * email, street address, or money is held back whole, never shown in part.
 *
 * The C1 read-only link must send exactly these fields (docs/SQUARE-NEXT.md).
 */

export const ORDER_FIELDS = [
  "id_tail",
  "fulfill_type",
  "event_date",
  "event_time",
  "ready_time",
  "guests",
  "lines",
] as const;

export const LINE_FIELDS = ["item_name", "variation", "modifiers", "qty"] as const;

export type FulfillType = "PICKUP" | "DELIVERY";

export type UpcomingLine = {
  item_name: string;
  variation: string;
  modifiers: string;
  qty: number;
};

export type UpcomingOrder = {
  id_tail: string;
  fulfill_type: FulfillType;
  event_date: string;
  event_time: string;
  ready_time: string | null;
  guests: number | null;
  lines: UpcomingLine[];
};

export type FenceResult = {
  orders: UpcomingOrder[];
  /** Orders dropped by the fence. Count only: the page never shows why. */
  heldBack: number;
};

const TAIL = /^[A-Za-z0-9]{4,8}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TEXT = 400;
const MAX_LINES = 200;

const STREET_SUFFIX =
  "(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|pkwy|parkway|hwy|highway|ct|court|cir|circle|trl|trail|pl|place|fwy|freeway|expy|loop)";
const STREET = new RegExp(`\\b\\d{1,6}\\s+(?:[a-z0-9.'-]+\\s+){0,3}${STREET_SUFFIX}\\b`, "i");
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const LONG_DIGITS = /\d{7,}/;
const MONEY = /[$€£]|\bUSD\b|\b\d+\.\d{2}\b/i;
const EMAIL = /@/;
const NAME_LABEL = /\b(?:customer|cliente|name|nombre|phone|tel[eé]fono|email|correo|address|direcci[oó]n)\s*[:=]/i;

/**
 * True when a piece of display text carries something the kitchen page must
 * not show. Square modifiers read "1 x STEAK - asada, 1 x No Drink"; the
 * leading "N x " is a quantity, so it is removed before the street check
 * ("1 x Dr Pepper" is a drink, not an address).
 */
export function forbiddenText(text: string): string | null {
  if (EMAIL.test(text)) return "email";
  if (MONEY.test(text)) return "money";
  if (PHONE.test(text) || LONG_DIGITS.test(text)) return "phone";
  if (NAME_LABEL.test(text)) return "label";
  for (const part of text.split(",")) {
    const bare = part.trim().replace(/^\d+\s*x\s+/i, "");
    if (STREET.test(bare)) return "address";
  }
  return null;
}

function cleanText(value: unknown): string | null {
  if (value == null) return "";
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length > MAX_TEXT) return null;
  if (forbiddenText(text)) return null;
  return text;
}

function cleanLine(raw: unknown): UpcomingLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const item_name = cleanText(r.item_name);
  const variation = cleanText(r.variation);
  const modifiers = cleanText(r.modifiers);
  const qty = typeof r.qty === "number" ? r.qty : Number(r.qty);
  if (!item_name || variation == null || modifiers == null) return null;
  if (!Number.isFinite(qty) || qty < 0 || qty > 10000) return null;
  return { item_name, variation, modifiers, qty };
}

/** One order through the allow-list, or null when it must be held back. */
export function fenceOrder(raw: unknown): UpcomingOrder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const id_tail = typeof r.id_tail === "string" ? r.id_tail.trim() : "";
  if (!TAIL.test(id_tail)) return null;

  const fulfill = typeof r.fulfill_type === "string" ? r.fulfill_type.trim().toUpperCase() : "";
  if (fulfill !== "PICKUP" && fulfill !== "DELIVERY") return null;

  const event_date = typeof r.event_date === "string" ? r.event_date.trim() : "";
  if (!YMD.test(event_date)) return null;

  const event_time = typeof r.event_time === "string" ? r.event_time.trim() : "";
  if (!HHMM.test(event_time)) return null;

  let ready_time: string | null = null;
  if (r.ready_time != null && r.ready_time !== "") {
    if (typeof r.ready_time !== "string" || !HHMM.test(r.ready_time.trim())) return null;
    ready_time = r.ready_time.trim();
  }

  let guests: number | null = null;
  if (r.guests != null && r.guests !== "") {
    const n = typeof r.guests === "number" ? r.guests : Number(r.guests);
    if (!Number.isInteger(n) || n < 0 || n > 10000) return null;
    guests = n;
  }

  if (!Array.isArray(r.lines) || r.lines.length === 0 || r.lines.length > MAX_LINES) return null;
  const lines: UpcomingLine[] = [];
  for (const rawLine of r.lines) {
    const line = cleanLine(rawLine);
    if (!line) return null;
    lines.push(line);
  }

  return { id_tail, fulfill_type: fulfill, event_date, event_time, ready_time, guests, lines };
}

/** The whole payload through the fence. Anything that is not `{ orders: [] }` yields nothing. */
export function fencePayload(payload: unknown): FenceResult {
  const list =
    payload && typeof payload === "object" && Array.isArray((payload as { orders?: unknown }).orders)
      ? ((payload as { orders: unknown[] }).orders)
      : null;
  if (!list) return { orders: [], heldBack: 0 };
  const orders: UpcomingOrder[] = [];
  let heldBack = 0;
  for (const raw of list) {
    const order = fenceOrder(raw);
    if (order) orders.push(order);
    else heldBack += 1;
  }
  return { orders, heldBack };
}
