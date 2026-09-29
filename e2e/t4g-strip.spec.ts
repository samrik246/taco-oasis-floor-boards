import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ensureSampleLoaded } from "./load-sample-api";

/**
 * Horario T4G strip. The host env stays unset. This spec serves the strip
 * route and /api/upcoming the same way e2e/next.spec.ts serves Próximos,
 * with the three kitchen records.
 */

function isUpcoming(url: URL): boolean {
  return url.pathname === "/api/upcoming" || url.pathname === "/api/upcoming/strip";
}

const FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "fixtures/square-next/orders.json"), "utf8"),
) as { orders: Record<string, unknown>[] };

const DAY = "2026-09-20";
const LATER = "2026-09-21";

async function keepDesk(page: Page) {
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    json.idleMs = 120_000;
    await route.fulfill({ response, json });
  });
}

async function unlock(page: Page) {
  if ((await page.getByTestId("floor-board").getAttribute("data-role")) === "manager") return;
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
}

async function selectDate(page: Page, targetYmd: string) {
  const bar = page.getByTestId("date-bar");
  for (let i = 0; i < 60; i++) {
    const current = await bar.getAttribute("data-date");
    if (current === targetYmd) return;
    if (!current || current < targetYmd) await page.getByTestId("date-next").click();
    else await page.getByTestId("date-prev").click();
  }
  throw new Error(`selectDate: could not reach ${targetYmd}`);
}

test("Horario opens on Hora and the strip follows the day on screen", async ({ page }) => {
  const [early, later, late] = FIXTURE.orders;
  const orders = [
    { ...late, event_date: DAY, event_time: "14:00" },
    { ...later, event_date: LATER, event_time: "10:50" },
    { ...early, event_date: DAY, event_time: "09:15" },
  ];
  let mode: "on" | "off" = "on";
  const today = DAY;

  await keepDesk(page);
  await page.goto("/");
  await expect(page.getByTestId("floor-board")).toBeVisible();
  await page.getByTestId("toolbar-more").click();
  await unlock(page);

  if (await ensureSampleLoaded(page, DAY)) {
    await page.getByTestId("toolbar-more").click();
    await unlock(page);
  }
  await selectDate(page, DAY);

  await page.route(isUpcoming, (route) =>
    route.fulfill({
      json:
        mode === "off"
          ? { source: "off", orders, heldBack: 0, fetchedAt: null, stale: false, today }
          : {
              source: "fixture",
              orders,
              heldBack: 0,
              fetchedAt: new Date().toISOString(),
              stale: false,
              today,
            },
    }),
  );

  await page.getByTestId("view-toggle-board").click();
  await page.getByTestId("view-toggle-schedule").click();
  await expect(page.getByTestId("schedule-sort-time")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("schedule-panel")).toHaveAttribute("data-sort", "time");
  await expect(page.getByTestId("schedule-panel")).toHaveAttribute("data-mode", "rest-of-day");
  await expect(page.getByTestId("schedule-sort-name")).toHaveCount(0);
  await expect(page.getByTestId("date-bar")).toHaveAttribute("data-date", DAY);

  const cells = page.locator("[data-testid='t4g-order']");
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(0)).toContainText("Listo 10:00 · 15 personas");
  await expect(cells.nth(0)).toContainText("RECOGER");
  await expect(cells.nth(0)).not.toContainText("AgIeZY");
  await expect(cells.nth(1)).toContainText("Listo 10:50 · 40 personas");
  await expect(cells.nth(1)).toContainText("ENTREGA");
  await expect(cells.nth(1)).not.toContainText("sr0GZY");
  await expect(page.getByTestId("t4g-strip")).not.toContainText("hj35YY");

  const url = page.url();
  const historyLength = await page.evaluate(() => history.length);
  await cells.nth(0).click();
  await expect(page.getByTestId("t4g-detail")).toBeVisible();
  await expect(page.getByTestId("t4g-detail")).toContainText("Listo 10:00 · 15 personas");
  await expect(page.getByTestId("t4g-detail")).toContainText("RECOGER");
  await expect(page.getByTestId("t4g-detail")).not.toContainText("AgIeZY");
  await expect(page.getByTestId("next-detail-close")).toContainText("Cerrar");
  await page.getByTestId("next-detail-close").click();
  await expect(page.getByTestId("t4g-detail")).toHaveCount(0);
  await expect(page.getByTestId("schedule-panel")).toHaveAttribute("data-sort", "time");
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  mode = "off";
  await page.getByTestId("view-toggle-board").click();
  await page.getByTestId("view-toggle-schedule").click();
  await expect(page.getByTestId("t4g-strip")).toHaveCount(0);
  await expect(page.getByTestId("schedule-panel")).toBeVisible();
});

test("the strip leads with the first name on cocina and caja, and Próximos stays nameless", async ({ page }) => {
  const named = {
    ...FIXTURE.orders[0],
    event_date: DAY,
    event_time: "11:30",
    ready_time: "11:00",
    guests: 16,
    fulfill_type: "PICKUP",
    first_name: "Ana",
  };
  const unnamed = {
    ...FIXTURE.orders[1],
    event_date: DAY,
    event_time: "12:30",
    ready_time: "10:30",
    guests: 24,
    fulfill_type: "DELIVERY",
    first_name: "",
  };
  const label = "Ana · Listo 11:00 · 16 personas";
  const plain = "Listo 10:30 · 24 personas";

  await page.route(isUpcoming, (route) => {
    const strip = new URL(route.request().url()).pathname.endsWith("/strip");
    const orders = strip
      ? [named, unnamed]
      : [{ ...named, first_name: "Ana" }, { ...unnamed, first_name: "Ana" }];
    return route.fulfill({
      json: {
        source: "fixture",
        orders,
        heldBack: 0,
        fetchedAt: new Date().toISOString(),
        stale: false,
        today: DAY,
      },
    });
  });

  await keepDesk(page);
  await page.goto("/");
  await expect(page.getByTestId("floor-board")).toBeVisible();
  await page.getByTestId("toolbar-more").click();
  await unlock(page);

  if (await ensureSampleLoaded(page, DAY)) {
    await page.getByTestId("toolbar-more").click();
    await unlock(page);
  }
  await selectDate(page, DAY);
  await page.getByTestId("view-toggle-schedule").click();

  const cells = page.locator("[data-testid='t4g-order-label']");
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(0)).toHaveText(label);
  await expect(cells.nth(1)).toHaveText(plain);
  await expect(page.getByTestId("t4g-strip")).not.toContainText("AgIeZY");

  await cells.nth(0).click();
  await expect(page.getByTestId("t4g-detail")).toContainText(label);
  await expect(page.getByTestId("t4g-detail")).toContainText("RECOGER");
  await expect(page.getByTestId("t4g-detail")).not.toContainText("AgIeZY");
  await page.getByTestId("next-detail-close").click();

  await page.getByTestId("board-toggle-cocina").click();
  await expect(page.getByTestId("t4g-order-label").nth(0)).toHaveText(label);
  await expect(page.getByTestId("t4g-order-label").nth(1)).toHaveText(plain);

  await page.getByTestId("board-toggle-caja").click();
  await expect(page.getByTestId("t4g-order-label").nth(0)).toHaveText(label);

  await page.goto("/next");
  await expect(page.getByTestId("next-list")).toBeVisible();
  await expect(page.locator("[data-testid^=next-card-]")).toHaveCount(2);
  await expect(page.getByTestId("next-list")).not.toContainText("Ana");
  await expect(page.getByTestId("next-list")).not.toContainText(label);
});
