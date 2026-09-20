import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 1 smoke: Load sample → Cashiers → traffic + tareas + assign + clear with reason.
 * Uses fresh disposable DB (prisma/e2e.db) via playwright webServer.
 */
test.describe("phase 1 cashiers smoke", () => {
  test("load sample, traffic, tarea, assign, ledger, move reason", async ({
    page,
  }) => {
    const e2eDb = path.resolve(process.cwd(), "prisma/e2e.db");
    expect(fs.existsSync(e2eDb)).toBe(true);

    await page.goto("/");

    await expect(page.getByTestId("floor-board")).toBeVisible();
    await expect(page.getByTestId("readonly-badge")).toHaveCount(0);

    await page.getByTestId("load-sample").click();
    await expect(page.getByTestId("toast")).toContainText(/Loaded sample/i, {
      timeout: 60_000,
    });

    await page.getByTestId("board-toggle-caja").click();
    await page.getByTestId("date-select").selectOption("2026-09-20");
    await expect(page.getByTestId("station-grid")).toBeVisible();
    await expect(page.getByTestId("traffic-meters")).toBeVisible();
    await expect(page.getByTestId("tareas-panel")).toBeVisible();

    // Enable fake order simulator (scroll past sticky header)
    const trafficToggle = page.getByTestId("traffic-toggle");
    await trafficToggle.scrollIntoViewIfNeeded();
    await expect(trafficToggle).toBeEnabled({ timeout: 15_000 });
    await trafficToggle.click({ force: true });
    await expect(trafficToggle).toBeChecked({ timeout: 5_000 });
    await expect(page.getByTestId("toast")).toContainText(/Simulator on/i, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("meter-cliente")).toBeVisible();

    await page.getByTestId("hour-12").click();

    const available = page.getByTestId("available-list").locator("button");
    await expect(available.first()).toBeVisible({ timeout: 30_000 });

    await available.first().click();
    await page.getByTestId("station-yellow").getByRole("button").first().click();

    await expect(page.getByTestId("toast")).toContainText(/Assigned/i, {
      timeout: 15_000,
    });

    // Assign a tarea via suggestions
    await page.getByTestId("tarea-template-select").selectOption("salsa");
    const suggestBtn = page.locator("[data-testid^='suggest-']").first();
    await expect(suggestBtn).toBeVisible({ timeout: 15_000 });
    await suggestBtn.click();
    await expect(page.getByTestId("toast")).toContainText(/Tarea assigned/i, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("tareas-working").locator("li")).not.toHaveCount(
      0,
    );

    // Clear yellow with move reason
    await page.getByTestId("clear-yellow").click();
    await expect(page.getByTestId("move-reason-modal")).toBeVisible();
    await page.getByTestId("move-reason-select").selectOption("Break");
    await page.getByTestId("move-reason-confirm").click();
    await expect(page.getByTestId("toast")).toContainText(/Cleared/i, {
      timeout: 15_000,
    });

    // Ledger still works after earlier assign
    const ledger = page.getByTestId("hours-ledger");
    await expect(ledger).toBeVisible();

    // Readonly mode still blocks mutations
    await page.goto("/?readonly=1");
    await expect(page.getByTestId("readonly-badge")).toBeVisible();
    await expect(page.getByTestId("load-sample")).toBeDisabled();
    await expect(page.getByTestId("traffic-toggle")).toBeDisabled();
  });
});
