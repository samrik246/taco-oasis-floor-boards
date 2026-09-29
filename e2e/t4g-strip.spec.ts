import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * Horario T4G strip. The host env stays unset. This spec serves /api/upcoming
 * the same way e2e/next.spec.ts does, with the three kitchen records.
 */

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

async function managerHeaders(page: Page) {
  const res = await page.request.post("/api/managers", { data: { code: "2468" } });
  expect(res.ok()).toBe(true);
  const { sessionToken } = (await res.json()) as { sessionToken: string };
  return { "x-manager-session": sessionToken };
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

  const days = (await (
    await page.request.get("/api/days", { headers: await managerHeaders(page) })
  ).json()) as { dates: string[] };
  if (!days.dates.includes(DAY)) {
    await page.getByTestId("load-sample").click();
    await expect(page.getByTestId("toast")).toContainText(/Loaded sample|Muestra cargada/i, {
      timeout: 60_000,
    });
  }
  await selectDate(page, DAY);

  await page.route("**/api/upcoming", (route) =>
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
  await expect(page.getByTestId("date-bar")).toHaveAttribute("data-date", DAY);

  const cells = page.locator("[data-testid^='t4g-order-']");
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(0)).toHaveAttribute("data-testid", "t4g-order-AgIeZY");
  await expect(cells.nth(0)).toContainText("9:15 am");
  await expect(cells.nth(0)).toContainText("RECOGER");
  await expect(cells.nth(1)).toHaveAttribute("data-testid", "t4g-order-sr0GZY");
  await expect(cells.nth(1)).toContainText("ENTREGA");
  await expect(page.getByTestId("t4g-order-hj35YY")).toHaveCount(0);

  const url = page.url();
  const historyLength = await page.evaluate(() => history.length);
  await page.getByTestId("t4g-order-AgIeZY").click();
  await expect(page.getByTestId("t4g-detail")).toBeVisible();
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
