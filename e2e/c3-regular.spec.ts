import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * C3 Regulares through the real route: the host's REGULAR_FEED_FILE points
 * into the disposable test root, and each test writes the feed snapshot
 * there. Fresh list, stale banner (Chicago clock), unreadable file, no leak.
 * Nothing here reads Square or the feed's real data folder.
 */

const FILE = path.join(process.env.FLOOR_BOARDS_TEST_ROOT ?? "", "regular_snapshot.json");
const FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "fixtures/regular/regular_snapshot.json"), "utf8"),
) as Record<string, unknown>;

const LEAKS = [
  "Lopez", "Garcia", "2145550187", "214-555-0199", "maria.lopez", "example.invalid",
  "4512", "Elm Street", "CUST_FIXTURE", "4321", "$5.00", "call Maria", "leave at", "nombre:",
];

function write(lastGood: string) {
  fs.writeFileSync(FILE, JSON.stringify({ ...FIXTURE, last_good_poll_at: lastGood }), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}

function chicagoHHMM(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** Every visible element that owns text, with a computed size under 20px. */
async function smallText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
      if (!own) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden") continue;
      if (el.closest("[aria-hidden='true'], script, style, noscript, next-route-announcer")) continue;
      if (parseFloat(style.fontSize) < 20) out.push(`${style.fontSize} "${own.slice(0, 40)}"`);
    }
    return out;
  });
}

test.describe("C3 Regulares", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1280, height: 900 } });

  test.afterEach(() => {
    try {
      fs.chmodSync(FILE, 0o600);
      fs.rmSync(FILE);
    } catch {
      /* already gone */
    }
  });

  test("Próximos links to Regulares when the host serves the feed", async ({ page }) => {
    write(new Date().toISOString());
    await page.goto("/next");
    await page.getByTestId("next-regular-link").click();
    await expect(page).toHaveURL(/\/next\/regular$/);
    await expect(page.getByTestId("regular-list")).toBeVisible();
  });

  test("fresh: the list shows, first name only, no leak, no small text", async ({ page }) => {
    write(new Date().toISOString());
    await page.goto("/next/regular");
    await expect(page.getByTestId("regular-list")).toBeVisible();
    await expect(page.locator("[data-testid^=regular-card-]")).toHaveCount(2);
    const card = page.getByTestId("regular-card-A1B2C3");
    await expect(card.getByTestId("regular-name")).toHaveText("Maria");
    await expect(card).toContainText("18:15");
    await expect(card).toContainText("sin cebolla");
    await expect(page.getByTestId("regular-held")).toBeVisible();
    await expect(page.getByTestId("regular-stale")).toHaveCount(0);
    const text = await page.locator("body").innerText();
    const html = await page.content();
    for (const token of LEAKS) {
      expect(text, token).not.toContain(token);
      expect(html, token).not.toContain(token);
    }
    expect(await smallText(page)).toEqual([]);
  });

  test("stale: Sin datos desde HH:MM (Chicago) instead of the list", async ({ page }) => {
    const last = new Date(Date.now() - 10 * 60_000).toISOString();
    write(last);
    await page.goto("/next/regular");
    await expect(page.getByTestId("regular-stale")).toHaveText(`Sin datos desde ${chicagoHHMM(last)}`);
    await expect(page.getByTestId("regular-list")).toHaveCount(0);
    await expect(page.getByTestId("regular-empty")).toHaveCount(0);
  });

  test("missing file: Sin datos todavía", async ({ page }) => {
    await page.goto("/next/regular");
    await expect(page.getByTestId("regular-stale")).toHaveText("Sin datos todavía");
  });

  test("unreadable file: the stale banner, not a crash", async ({ page }) => {
    write(new Date().toISOString());
    fs.chmodSync(FILE, 0o000);
    const res = await page.request.get("/api/upcoming/regular");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    await page.goto("/next/regular");
    await expect(page.getByTestId("regular-stale")).toHaveText("Sin datos todavía");
  });

  test("fresh and empty: the empty line, not the banner", async ({ page }) => {
    fs.writeFileSync(FILE, JSON.stringify({ last_good_poll_at: new Date().toISOString(), orders: [] }), { mode: 0o600 });
    await page.goto("/next/regular");
    await expect(page.getByTestId("regular-empty")).toBeVisible();
    await expect(page.getByTestId("regular-stale")).toHaveCount(0);
  });
});
