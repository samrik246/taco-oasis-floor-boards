import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Stage 3 slice 14 smoke:
 * Load sample → Cashiers → date with shifts → assign → ledger updates.
 * Uses fresh disposable DB (prisma/e2e.db) via playwright webServer.
 */
test.describe("floor board smoke", () => {
  test("load sample, assign on Cashiers, ledger bumps", async ({ page }) => {
    // Ensure disposable DB path is the e2e one (webServer sets DATABASE_URL)
    const e2eDb = path.resolve(process.cwd(), "prisma/e2e.db");
    expect(fs.existsSync(e2eDb)).toBe(true);

    await page.goto("/");

    await expect(page.getByTestId("floor-board")).toBeVisible();
    await expect(page.getByTestId("readonly-badge")).toHaveCount(0);

    // Load sample fixture
    await page.getByTestId("load-sample").click();
    await expect(page.getByTestId("toast")).toContainText(/Loaded sample/i, {
      timeout: 60_000,
    });

    // Cashiers board (default) + Sep 20
    await page.getByTestId("board-toggle-caja").click();
    await page.getByTestId("date-select").selectOption("2026-09-20");
    await expect(page.getByTestId("station-grid")).toBeVisible();

    // Hour with shifts — noon
    await page.getByTestId("hour-12").click();

    // Wait for available people
    const available = page.getByTestId("available-list").locator("button");
    await expect(available.first()).toBeVisible({ timeout: 30_000 });

    // Select person then Yellow station
    await available.first().click();
    await page.getByTestId("station-yellow").getByRole("button").first().click();

    await expect(page.getByTestId("toast")).toContainText(/Assigned/i, {
      timeout: 15_000,
    });

    // Ledger panel should show minutes for yellow (or any station)
    const ledger = page.getByTestId("hours-ledger");
    await expect(ledger).toBeVisible();
    await expect
      .poll(async () => {
        const empty = await page.getByTestId("hours-ledger-empty").count();
        const rows = await page.getByTestId("hours-ledger-rows").count();
        return empty === 0 && rows === 1;
      }, { timeout: 15_000 })
      .toBe(true);

    const row = page
      .getByTestId("hours-ledger-rows")
      .locator("[data-minutes]")
      .first();
    const minutes = Number(await row.getAttribute("data-minutes"));
    expect(minutes).toBeGreaterThanOrEqual(60);

    // Manager notes slot present
    await expect(page.getByTestId("manager-notes")).toBeVisible();

    // Readonly mode: board usable, mutations blocked
    await page.goto("/?readonly=1");
    await expect(page.getByTestId("readonly-badge")).toBeVisible();
    await expect(page.getByTestId("load-sample")).toBeDisabled();
    await expect(page.getByTestId("notes-add")).toHaveCount(0);
    await expect(page.getByTestId("floor-board")).toHaveAttribute(
      "data-readonly",
      "1",
    );
  });
});
