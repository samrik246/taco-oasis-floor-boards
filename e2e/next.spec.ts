import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * SQUARE NEXT readable pass. The page reads /api/upcoming in the browser, so
 * the test serves that one route itself: the real three kitchen records with
 * their dates moved to today, tomorrow and later on the Chicago clock. The
 * host keeps NEXT_SOURCE unset (dark); nothing here reads C1 or Square.
 */

const FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "fixtures/square-next/orders.json"), "utf8"),
) as { orders: Record<string, unknown>[] };

function chicagoDay(offset: number): string {
  const now = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}

async function serveOrders(page: Page) {
  const days = [chicagoDay(0), chicagoDay(1), chicagoDay(9)];
  const orders = FIXTURE.orders.map((o, i) => ({ ...o, event_date: days[i] }));
  await page.route("**/api/upcoming", (route) =>
    route.fulfill({
      json: {
        source: "fixture",
        orders,
        heldBack: 0,
        fetchedAt: new Date().toISOString(),
        stale: false,
        today: days[0],
      },
    }),
  );
  return { today: days[0], tomorrow: days[1] };
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
      const size = parseFloat(style.fontSize);
      if (size < 20) out.push(`${size}px "${own.slice(0, 40)}"`);
    }
    return out;
  });
}

test.describe("SQUARE NEXT readable", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("no visible text under 20px on list, week, month, options and detail", async ({ page }) => {
    await serveOrders(page);
    await page.goto("/next");
    await expect(page.getByTestId("next-list")).toBeVisible();
    await expect(page.locator("[data-testid^=next-card-]")).toHaveCount(3);
    expect(await smallText(page), "list").toEqual([]);

    await page.getByTestId("next-options").click();
    await expect(page.getByTestId("next-columns")).toBeVisible();
    expect(await smallText(page), "options").toEqual([]);
    await page.getByTestId("next-options").click();

    await page.getByTestId("next-view-week").click();
    await expect(page.getByTestId("next-week")).toBeVisible();
    expect(await smallText(page), "week").toEqual([]);

    await page.getByTestId("next-view-month").click();
    await expect(page.getByTestId("next-month")).toBeVisible();
    expect(await smallText(page), "month").toEqual([]);

    await page.getByTestId("next-view-list").click();
    await page.getByTestId("next-card-hj35YY").click();
    await expect(page.getByTestId("next-sheet")).toBeVisible();
    expect(await smallText(page), "detail").toEqual([]);

    await page.getByTestId("next-detail-close").click();
    await page.getByTestId("next-locale").click();
    await expect(page.getByTestId("next-locale")).toHaveText("Español");
    expect(await smallText(page), "list en").toEqual([]);
    await page.getByTestId("next-card-hj35YY").click();
    await expect(page.getByTestId("next-sheet")).toBeVisible();
    expect(await smallText(page), "detail en").toEqual([]);
  });

  test("the detail sheet closes by Back, Cerrar or Volver, and Back then leaves /next", async ({ page }) => {
    await serveOrders(page);
    await page.goto("/");
    await page.goto("/next");
    await expect(page.getByTestId("next-list")).toBeVisible();

    await page.getByTestId("next-card-hj35YY").click();
    await expect(page.getByTestId("next-sheet")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("next-sheet")).toHaveCount(0);
    await expect(page).toHaveURL(/\/next$/);

    await page.getByTestId("next-card-hj35YY").click();
    await page.getByTestId("next-detail-close").click();
    await expect(page.getByTestId("next-sheet")).toHaveCount(0);

    await page.getByTestId("next-card-AgIeZY").click();
    await page.getByTestId("next-detail-back").click();
    await expect(page.getByTestId("next-sheet")).toHaveCount(0);
    await expect(page).toHaveURL(/\/next$/);

    // Every sheet entry was popped once: one more Back leaves the page.
    await page.goBack();
    await expect(page).not.toHaveURL(/\/next$/);
  });

  test("HOY and MAÑANA chips, fulfill colors with words, and a month tap opens that day", async ({ page }) => {
    const { today, tomorrow } = await serveOrders(page);
    await page.goto("/next");
    const first = page.getByTestId(`next-day-${today}`).locator("[data-testid=next-urgency]").first();
    await expect(first).toHaveText("HOY");
    await expect(first).toHaveAttribute("data-urgency", "today");
    await expect(
      page.getByTestId(`next-day-${tomorrow}`).locator("[data-testid=next-urgency]").first(),
    ).toHaveText("MAÑANA");
    const colors: Record<string, Set<string>> = { DELIVERY: new Set(), PICKUP: new Set() };
    for (const card of await page.locator("[data-testid^=next-card-]").all()) {
      const fulfill = (await card.getAttribute("data-fulfill")) as "DELIVERY" | "PICKUP";
      await expect(card.getByTestId("next-fulfill-word")).toHaveText(fulfill === "DELIVERY" ? "ENTREGA" : "RECOGER");
      const { left, top } = await card.evaluate((el) => ({
        left: getComputedStyle(el).borderLeftColor,
        top: getComputedStyle(el).borderTopColor,
      }));
      expect(left, `${fulfill} bar is colored`).not.toBe(top);
      colors[fulfill].add(left);
    }
    // One color per fulfill type, and the two types differ.
    expect(colors.DELIVERY.size).toBe(1);
    expect(colors.PICKUP.size).toBe(1);
    expect([...colors.DELIVERY][0]).not.toBe([...colors.PICKUP][0]);

    await page.getByTestId("next-view-month").click();
    if (tomorrow.slice(0, 7) !== today.slice(0, 7)) await page.getByTestId("next-next").click();
    await page.getByTestId(`next-month-day-${tomorrow}`).click();
    await expect(page.getByTestId("next-list")).toBeVisible();
    await expect(page.getByTestId(`next-day-${tomorrow}`)).toBeInViewport();
  });
});
