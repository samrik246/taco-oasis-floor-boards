import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINE_FIELDS,
  ORDER_FIELDS,
  fenceOrder,
  fencePayload,
  forbiddenText,
} from "@/lib/upcoming/fence";
import {
  FixtureSource,
  SHEET_REFRESH_MS,
  SheetSource,
  chicagoToday,
  nextEnabled,
  sourceFromEnv,
} from "@/lib/upcoming/source";
import { monthGrid, weekDays, addMonths } from "@/lib/upcoming/calendar";
import { OrderDetail } from "@/components/next/OrderDetail";
import { NEXT_COPY } from "@/components/next/next-copy";
import { DEFAULT_PREFS, parsePrefs } from "@/components/next/prefs";

/**
 * The fence is checked with its own patterns here, not the app's, so a bug
 * in forbiddenText cannot also blind the test.
 */
const LEAKS: [string, RegExp][] = [
  ["money", /\$/],
  ["email", /@/],
  ["phone", /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/],
  ["street", /\b\d{1,6}\s+[A-Za-z]+\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Ln|Drive)\b/],
];

function leaks(text: string): string[] {
  return LEAKS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Visible text plus every attribute value of rendered markup. */
function renderedStrings(html: string): string {
  const attrs = [...html.matchAll(/="([^"]*)"/g)].map((m) => m[1]);
  const text = html.replace(/<[^>]*>/g, " ");
  return [text, ...attrs].join("\n");
}

const REAL = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures/square-next/orders.json"), "utf8"),
) as { orders: Record<string, unknown>[] };

function hostile(): Record<string, unknown> {
  return {
    ...structuredClone(REAL.orders[1]),
    order_id: "hj35YYfullSquareOrderIdAAAAAA",
    customer_name: "Maria Example",
    customer_phone: "(214) 555-0100",
    customer_email: "maria@example.com",
    address: "1234 Main Street",
    total_money: { amount: 45000, currency: "USD" },
    note: "call 214 555 0100",
  };
}

describe("SQUARE NEXT fixture source (the three real C1 kitchen records)", () => {
  it("shows only orders dated today or later in Chicago, soonest first", async () => {
    // 25 Sep 2026 02:00Z is still 24 Sep in Chicago.
    const snap = await new FixtureSource().load(new Date("2026-09-25T02:00:00Z"));
    expect(chicagoToday(new Date("2026-09-25T02:00:00Z"))).toBe("2026-09-24");
    expect(snap.source).toBe("fixture");
    expect(snap.heldBack).toBe(0);
    expect(snap.orders.map((o) => o.id_tail)).toEqual(["hj35YY", "AgIeZY"]);
    expect(snap.orders.map((o) => o.guests)).toEqual([20, 15]);
    expect(snap.orders.map((o) => o.fulfill_type)).toEqual(["DELIVERY", "PICKUP"]);
  });

  it("keeps an order on its event day and drops it the day after", async () => {
    const on = await new FixtureSource().load(new Date("2026-09-23T15:00:00Z"));
    expect(on.orders.map((o) => o.id_tail)).toContain("sr0GZY");
    const after = await new FixtureSource().load(new Date("2026-09-24T15:00:00Z"));
    expect(after.orders.map((o) => o.id_tail)).not.toContain("sr0GZY");
  });

  it("every real modifier line passes the fence", () => {
    const { orders, heldBack } = fencePayload(REAL);
    expect(heldBack).toBe(0);
    expect(orders).toHaveLength(3);
  });
});

describe("SQUARE NEXT field allow-list", () => {
  it("keeps only kitchen-record fields and drops everything else", () => {
    const order = fenceOrder(hostile());
    expect(order).not.toBeNull();
    expect(Object.keys(order!).sort()).toEqual([...ORDER_FIELDS].sort());
    for (const line of order!.lines) {
      expect(Object.keys(line).sort()).toEqual([...LINE_FIELDS].sort());
    }
    const json = JSON.stringify(order);
    for (const bad of ["Maria", "555", "example.com", "Main", "45000", "USD", "fullSquareOrderId", "call"]) {
      expect(json).not.toContain(bad);
    }
    expect(leaks(json)).toEqual([]);
  });

  it("holds back an order whose kitchen text carries a phone, email, address, or money", () => {
    const cases = [
      "1 x Sweet Tea, call 214-555-0100",
      "1 x Sweet Tea, ask for maria@example.com",
      "1 x Sweet Tea, deliver to 1234 Main St",
      "1 x Sweet Tea, deliver to 55 Oak Hollow Drive",
      "1 x Sweet Tea, tip $25.00",
      "1 x Sweet Tea, 45.00",
      "Customer: Maria",
      "1 x Sweet Tea 2145550100",
    ];
    for (const modifiers of cases) {
      const raw = hostile();
      (raw.lines as Record<string, unknown>[])[0].modifiers = modifiers;
      const { orders, heldBack } = fencePayload({ orders: [raw, REAL.orders[0]] });
      expect(heldBack, modifiers).toBe(1);
      expect(orders.map((o) => o.id_tail)).toEqual([REAL.orders[0].id_tail]);
    }
  });

  it("holds back an order with a bad tail, date, time, or fulfillment", () => {
    const bad: [string, unknown][] = [
      ["id_tail", "hj35YYfullSquareOrderIdAAAAAA"],
      ["id_tail", "hj-35"],
      ["event_date", "09/28/2026"],
      ["event_time", "2026-09-28T15:50:00Z"],
      ["fulfill_type", "SHIPMENT"],
      ["guests", "22 (confirm)"],
      ["lines", []],
    ];
    for (const [field, value] of bad) {
      const raw = { ...hostile(), [field]: value };
      expect(fenceOrder(raw), `${field}=${String(value)}`).toBeNull();
    }
  });

  it("does not mistake kitchen words for addresses", () => {
    for (const text of [
      "1 x Dr Pepper",
      "1 x STEAK - asada, 1 x No Drink",
      "1 x Beans & Rice, 1 x Chips and Queso",
      "Aguas Frescas Gallon",
      "1 x piña",
    ]) {
      expect(forbiddenText(text), text).toBeNull();
    }
  });

  it("a payload that is not an orders list yields nothing", () => {
    for (const p of [null, "x", { error: "bad key" }, { orders: "x" }]) {
      expect(fencePayload(p)).toEqual({ orders: [], heldBack: 0 });
    }
  });
});

describe("SQUARE NEXT rendered page", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("the detail shows event time, ready-by, fulfillment, guests, and lines with no private text", () => {
    const leaky = hostile();
    leaky.id_tail = "LEAK01";
    (leaky.lines as Record<string, unknown>[])[0].modifiers = "1 x Sweet Tea, maria@example.com 214-555-0100, $45.00";
    const { orders, heldBack } = fencePayload({ orders: [...REAL.orders, hostile(), leaky] });
    expect(heldBack).toBe(1);
    expect(orders).toHaveLength(4);
    for (const locale of ["es", "en"] as const) {
      for (const order of orders) {
        const html = renderToStaticMarkup(
          createElement(OrderDetail, { order, columns: DEFAULT_PREFS.columns, t: NEXT_COPY[locale] }),
        );
        const strings = renderedStrings(html);
        expect(leaks(strings), `${order.id_tail} ${locale}`).toEqual([]);
        expect(strings).not.toContain("Maria");
        expect(strings).toContain(order.event_time);
        expect(strings).toContain(order.event_date);
        for (const line of order.lines) expect(strings).toContain(line.item_name);
      }
    }
    const hj = orders.find((o) => o.id_tail === "hj35YY")!;
    const html = renderToStaticMarkup(
      createElement(OrderDetail, { order: hj, columns: DEFAULT_PREFS.columns, t: NEXT_COPY.es }),
    );
    expect(html).toContain("ENTREGA");
    expect(html).toContain("20 (confirmar)");
    expect(html).toContain("10:50");
  });

  it("the API route returns fenced kitchen fields only", async () => {
    vi.stubEnv("NEXT_SOURCE", "fixture");
    vi.resetModules();
    const { GET } = await import("@/app/api/upcoming/route");
    const res = await GET();
    const text = await res.text();
    const body = JSON.parse(text) as { source: string; orders: Record<string, unknown>[] };
    expect(body.source).toBe("fixture");
    expect(body.orders.length).toBeGreaterThan(0);
    for (const o of body.orders) {
      expect(Object.keys(o).sort()).toEqual([...ORDER_FIELDS].sort());
    }
    expect(leaks(text)).toEqual([]);
  });

  it("with NEXT_SOURCE unset the routes serve no orders and the floor link stays hidden", async () => {
    vi.stubEnv("NEXT_SOURCE", undefined as unknown as string);
    delete process.env.NEXT_SOURCE;
    vi.resetModules();
    const { GET } = await import("@/app/api/upcoming/route");
    const body = (await (await GET()).json()) as { source: string; orders: unknown[]; stale: boolean };
    expect(body).toMatchObject({ source: "off", orders: [], stale: false });
    const status = await import("@/app/api/upcoming/status/route");
    expect(await (await status.GET()).json()).toEqual({ enabled: false });
  });

  it("no Square token, Square host, or Bearer header anywhere in the NEXT code", () => {
    const roots = ["src/lib/upcoming", "src/app/api/upcoming", "src/app/next", "src/components/next"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    roots.forEach((r) => walk(path.join(process.cwd(), r)));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/squareup|square_access_token|SQUARE_TOKEN|Bearer/i);
    }
  });
});

describe("SQUARE NEXT sheet source (off until C1's read-only link exists)", () => {
  const url = "https://script.google.com/macros/s/TESTDEPLOY/exec";

  function fakeFetch(responses: (() => Promise<Response>)[]) {
    const calls: string[] = [];
    const impl = (u: string) => {
      calls.push(u);
      const next = responses.shift();
      return next ? next() : Promise.reject(new Error("no response"));
    };
    return { calls, impl };
  }

  const ok = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it("is dark by default; fixture is an explicit test switch; sheet fails closed when half set", async () => {
    const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
    const cases: Record<string, string>[] = [{}, { C1_NEXT_URL: url, C1_NEXT_KEY: "k" }, { NEXT_SOURCE: "yes" }];
    for (const e of cases) {
      const src = sourceFromEnv(env(e));
      expect(src.kind).toBe("off");
      expect(await src.load()).toEqual({ source: "off", orders: [], heldBack: 0, fetchedAt: null, stale: false });
      expect(nextEnabled(env(e))).toBe(false);
    }
    expect(sourceFromEnv(env({ NEXT_SOURCE: "fixture" })).kind).toBe("fixture");
    expect(nextEnabled(env({ NEXT_SOURCE: "fixture" }))).toBe(true);
    expect(nextEnabled(env({ NEXT_SOURCE: "sheet" }))).toBe(true);
    const half = sourceFromEnv({ NEXT_SOURCE: "sheet", C1_NEXT_URL: url } as unknown as NodeJS.ProcessEnv);
    expect(half.kind).toBe("sheet");
    const snap = await half.load(new Date("2026-09-25T15:00:00Z"));
    expect(snap).toMatchObject({ orders: [], stale: true, fetchedAt: null });
    const http = sourceFromEnv({ NEXT_SOURCE: "sheet", C1_NEXT_URL: "http://x", C1_NEXT_KEY: "k" } as unknown as NodeJS.ProcessEnv);
    expect((await http.load()).stale).toBe(true);
  });

  it("sends the key as a query parameter, reads once per 5 minutes, and fences the rows", async () => {
    const { calls, impl } = fakeFetch([ok({ orders: [hostile()] }), ok({ orders: [] })]);
    const src = new SheetSource(url, "sekret", impl);
    const t0 = new Date("2026-09-25T15:00:00Z");
    const a = await src.load(t0);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).searchParams.get("key")).toBe("sekret");
    expect(a).toMatchObject({ source: "sheet", stale: false, heldBack: 0 });
    expect(a.orders.map((o) => o.id_tail)).toEqual(["hj35YY"]);
    expect(JSON.stringify(a)).not.toContain("sekret");
    expect(leaks(JSON.stringify(a))).toEqual([]);

    await src.load(new Date(t0.getTime() + SHEET_REFRESH_MS - 1));
    expect(calls).toHaveLength(1);
    const c = await src.load(new Date(t0.getTime() + SHEET_REFRESH_MS));
    expect(calls).toHaveLength(2);
    expect(c.orders).toEqual([]);
  });

  it("keeps the last good orders and marks them stale when a read fails", async () => {
    const { impl } = fakeFetch([
      ok({ orders: [REAL.orders[0]] }),
      () => Promise.resolve(new Response("<html>error</html>", { status: 200 })),
      ok({ error: "bad key" }),
      () => Promise.resolve(new Response("nope", { status: 500 })),
    ]);
    const src = new SheetSource(url, "k", impl);
    const t0 = new Date("2026-09-25T15:00:00Z").getTime();
    const first = await src.load(new Date(t0));
    expect(first.stale).toBe(false);
    for (let i = 1; i <= 3; i++) {
      const snap = await src.load(new Date(t0 + i * SHEET_REFRESH_MS));
      expect(snap.stale).toBe(true);
      expect(snap.orders.map((o) => o.id_tail)).toEqual(["AgIeZY"]);
      expect(snap.fetchedAt).toBe(new Date(t0).toISOString());
    }
  });
});

describe("SQUARE NEXT calendar and tablet choices", () => {
  it("builds Sunday-first weeks on plain dates", () => {
    const oct = monthGrid("2026-10-15");
    expect(oct[0][0]).toBe("2026-09-27");
    expect(oct).toHaveLength(5);
    expect(oct.at(-1)!.at(-1)).toBe("2026-10-31");
    expect(weekDays("2026-09-28")).toEqual([
      "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03",
    ]);
    expect(addMonths("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("reads saved choices field by field and falls back on junk", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("{")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ view: "week", locale: "en", columns: { guests: false } }))).toEqual({
      view: "week",
      locale: "en",
      columns: { ...DEFAULT_PREFS.columns, guests: false },
    });
    expect(parsePrefs(JSON.stringify({ view: "year", locale: "fr" })).view).toBe("month");
  });
});
