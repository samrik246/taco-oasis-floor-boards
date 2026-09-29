import { test, expect, type Page } from "@playwright/test";
import { ensureSampleLoaded } from "./load-sample-api";

async function keepDesk(page: Page) {
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    json.idleMs = 120_000;
    await route.fulfill({ response, json });
  });
}

async function unlock(page: Page) {
  await page.goto("/");
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

test("both boards render the S14 station colours", async ({ page }) => {
  await keepDesk(page);
  await unlock(page);
  if (await ensureSampleLoaded(page)) await unlock(page);
  await page.getByTestId("board-toggle-caja").click();
  await selectDate(page, "2026-09-20");
  await page.getByTestId("view-toggle-board").click();
  await expect(page.getByTestId("station-grid")).toBeVisible();
  await expect(page.getByTestId("station-green1")).toHaveClass(/bg-green-300/);
  await expect(page.getByTestId("station-mesero")).toHaveClass(/bg-orange-200/);
  await expect(page.getByTestId("station-nieves")).toHaveClass(/bg-pink-200/);
  await page.screenshot({ path: "test-results/s14-caja.png", fullPage: true });

  await page.getByTestId("board-toggle-cocina").click();
  await expect(page.getByTestId("station-pdf_crne")).toHaveClass(/bg-orange-300/);
  await expect(page.getByTestId("station-pdf_rlno")).toHaveClass(/bg-orange-600/);
  await expect(page.getByTestId("station-pdf_br1a")).toHaveClass(/bg-\[#e4c49a\]/);
  await expect(page.getByTestId("station-pdf_br2a")).toHaveClass(/bg-\[#6f4e37\]/);
  await page.screenshot({ path: "test-results/s14-cocina.png", fullPage: true });
});
