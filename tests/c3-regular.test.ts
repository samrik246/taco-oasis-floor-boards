import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REGULAR_FIELDS, REGULAR_ITEM_FIELDS, fenceRegularPayload } from "@/lib/regular/fence";
import { REGULAR_STALE_AFTER_SECONDS, loadRegular, regularEnabled } from "@/lib/regular/source";
import { chicagoClock } from "@/lib/regular/clock";
import { REGULAR_COPY } from "@/components/regular/regular-copy";
import { RegularCard, staleLine } from "@/components/regular/RegularOrders";

/**
 * C3 regular orders on the boards side. Fixture snapshot only: nothing here
 * reads Square, Lavu or the feed's real data folder.
 */

const FIXTURE = path.resolve(process.cwd(), "fixtures/regular/regular_snapshot.json");
const POLL = "2026-09-29T23:30:00Z";

/** Everything the page must never carry, taken from the fixture's injected fields and notes. */
const LEAKS = [
  "Lopez", "Garcia", "+12145550187", "2145550187", "214-555-0199", "555-0199",
  "maria.lopez", "example.invalid", "4512", "Elm Street", "CUST_FIXTURE", "4321",
  "total_money", "phone_number", "email_address", "customer_id", "address_line_1",
  "base_price_money", "$5.00", "call Maria", "leave at", "nombre:", "sqonline-regular",
];

function expectClean(text: string) {
  for (const token of LEAKS) expect(text, token).not.toContain(token);
}

let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "c3-regular-"));
  file = path.join(dir, "regular_snapshot.json");
});

afterEach(() => {
  try {
    chmodSync(file, 0o600);
  } catch {
    /* file may not exist */
  }
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function envFor(target = file): NodeJS.ProcessEnv {
  return { REGULAR_FEED_FILE: target } as unknown as NodeJS.ProcessEnv;
}

function writeSnapshot(lastGood: string | null) {
  const doc = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  if (lastGood == null) delete doc.last_good_poll_at;
  else doc.last_good_poll_at = lastGood;
  writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
}

describe("C3 regular fence", () => {
  const { orders, heldBack, textBlanked } = fenceRegularPayload(JSON.parse(readFileSync(FIXTURE, "utf8")));

  it("keeps only the allow-listed fields", () => {
    expect(orders).toHaveLength(2);
    for (const o of orders) {
      expect(Object.keys(o).sort()).toEqual([...REGULAR_FIELDS].sort());
      for (const item of o.items) expect(Object.keys(item).sort()).toEqual([...REGULAR_ITEM_FIELDS].sort());
    }
  });

  it("holds back a bad shape whole and counts it", () => {
    expect(heldBack).toBe(1);
  });

  it("blanks a line note or modifier that looks like a phone, street, label or money, and counts it (A)", () => {
    const items = Object.fromEntries(orders[0].items.map((i) => [i.name, i]));
    expect(items["Taco al Pastor"].note).toBe("sin cebolla");
    expect(items["Quesadilla"].note).toBe("");
    expect(items["Horchata"].note).toBe("");
    expect(items["Burrito"].modifiers).toEqual(["1 x Dr Pepper"]);
    expect(textBlanked).toBe(4);
  });

  it("keeps the first word of the name only", () => {
    expect(orders[0].first_name).toBe("Maria");
    expect(orders[1].first_name).toBe("");
  });

  it("carries nothing forbidden", () => {
    expectClean(JSON.stringify(orders));
  });
});

describe("C3 regular source", () => {
  it("is off unless REGULAR_FEED_FILE is an absolute path", async () => {
    expect(regularEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(regularEnabled({ REGULAR_FEED_FILE: "data/x.json" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(regularEnabled(envFor())).toBe(true);
    const snap = await loadRegular(new Date(POLL), {} as NodeJS.ProcessEnv);
    expect(snap.source).toBe("off");
    expect(snap.orders).toEqual([]);
  });

  it("shows the list while fresh (within 300 s)", async () => {
    writeSnapshot(POLL);
    const snap = await loadRegular(new Date(Date.parse(POLL) + REGULAR_STALE_AFTER_SECONDS * 1000), envFor());
    expect(snap.fresh).toBe(true);
    expect(snap.orders.map((o) => o.id_tail)).toEqual(["A1B2C3", "D4E5F6"]);
    expect(snap.lastGoodClock).toBe("18:30");
  });

  it("goes stale after 300 s and drops the list", async () => {
    writeSnapshot(POLL);
    const snap = await loadRegular(new Date(Date.parse(POLL) + (REGULAR_STALE_AFTER_SECONDS + 1) * 1000), envFor());
    expect(snap.fresh).toBe(false);
    expect(snap.orders).toEqual([]);
    expect(snap.lastGoodClock).toBe("18:30");
  });

  it("missing file: no data yet, no crash", async () => {
    const snap = await loadRegular(new Date(POLL), envFor(path.join(dir, "missing.json")));
    expect(snap).toMatchObject({ source: "file", fresh: false, lastGoodClock: null, orders: [] });
  });

  it("unreadable file (wrong owner / mode): stale banner, not a crash (B)", async () => {
    writeSnapshot(POLL);
    chmodSync(file, 0o000);
    const snap = await loadRegular(new Date(POLL), envFor());
    expect(snap).toMatchObject({ source: "file", fresh: false, lastGoodClock: null, orders: [] });
  });

  it("bad JSON or no last_good_poll_at: stale, no crash", async () => {
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect((await loadRegular(new Date(POLL), envFor())).fresh).toBe(false);
    writeSnapshot(null);
    expect((await loadRegular(new Date(POLL), envFor())).fresh).toBe(false);
  });

  it("a stamp far in the future is not fresh", async () => {
    writeSnapshot("2026-09-30T23:30:00Z");
    expect((await loadRegular(new Date(POLL), envFor())).fresh).toBe(false);
  });
});

describe("C3 Chicago clock across UTC midnight (C)", () => {
  it("names the Chicago time, not UTC, when UTC has passed midnight", async () => {
    // 04:58Z on the 30th is 23:58 on the 29th in Chicago (CDT).
    writeSnapshot("2026-09-30T04:58:00Z");
    const snap = await loadRegular(new Date("2026-09-30T05:10:00Z"), envFor());
    expect(snap.fresh).toBe(false);
    expect(snap.lastGoodClock).toBe("23:58");
    expect(staleLine(REGULAR_COPY.es, snap.lastGoodClock)).toBe("Sin datos desde 23:58");
    expect(staleLine(REGULAR_COPY.es, null)).toBe("Sin datos todavía");
  });

  it("formats the same way whatever TZ the server runs in", () => {
    const prev = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      expect(chicagoClock("2026-09-30T00:30:00Z")).toBe("19:30");
      process.env.TZ = "Asia/Tokyo";
      expect(chicagoClock("2026-09-30T00:30:00Z")).toBe("19:30");
    } finally {
      process.env.TZ = prev;
    }
  });
});

describe("C3 regular route and card", () => {
  it("GET /api/upcoming/regular: no-store, fenced, no leak", async () => {
    copyFileSync(FIXTURE, file);
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    doc.last_good_poll_at = new Date().toISOString();
    writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    vi.stubEnv("REGULAR_FEED_FILE", file);
    const { GET } = await import("@/app/api/upcoming/regular/route");
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text) as { fresh: boolean; orders: unknown[]; textBlanked: number };
    expect(body.fresh).toBe(true);
    expect(body.orders).toHaveLength(2);
    expect(body.textBlanked).toBe(4);
    expectClean(text);
  });

  it("status route says off when the file is not named", async () => {
    vi.stubEnv("REGULAR_FEED_FILE", "");
    const { GET } = await import("@/app/api/upcoming/regular/status/route");
    expect(await (await GET()).json()).toEqual({ enabled: false });
    vi.stubEnv("REGULAR_FEED_FILE", file);
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });

  it("the rendered card shows first name, times in Chicago and clean lines only", () => {
    const { orders } = fenceRegularPayload(JSON.parse(readFileSync(FIXTURE, "utf8")));
    const html = renderToStaticMarkup(
      createElement(RegularCard, { order: orders[0], t: REGULAR_COPY.es, zebra: false }),
    );
    expect(html).toContain("Maria");
    expect(html).toContain("18:15");
    expect(html).toContain("17:40");
    expect(html).toContain("RECOGER");
    expect(html).toContain("sin cebolla");
    expectClean(html);
    const nameless = renderToStaticMarkup(
      createElement(RegularCard, { order: orders[1], t: REGULAR_COPY.es, zebra: true }),
    );
    expect(nameless).toContain("Sin nombre");
    expect(nameless).toContain("ENTREGA");
  });
});
