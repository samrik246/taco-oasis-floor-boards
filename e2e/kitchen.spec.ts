import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Kitchen e2e scenarios A–F from kitchen-e2e-scenarios.md.
 * Shares disposable prisma/e2e.db with Cashiers smoke via playwright webServer.
 */
test.describe("kitchen phase smoke", () => {
  test("A–F: kitchen board, assign, tareas, traffic, hours, cashiers still works", async ({
    page,
  }) => {
    const e2eDb = path.resolve(process.cwd(), "prisma/e2e.db");
    expect(fs.existsSync(e2eDb)).toBe(true);

    await page.goto("/");
    await expect(page.getByTestId("floor-board")).toBeVisible();

    // Load sample once
    await page.getByTestId("load-sample").click();
    await expect(page.getByTestId("toast")).toContainText(/Loaded sample/i, {
      timeout: 60_000,
    });

    // --- Scenario A: Kitchen board loads ---
    await page.getByTestId("board-toggle-cocina").click();
    await page.getByTestId("date-select").selectOption("2026-09-20");
    await expect(page.getByTestId("station-grid")).toBeVisible();
    for (const id of [
      "fryer",
      "tortilla",
      "birria",
      "taquero",
      "carne",
      "prepa",
    ]) {
      await expect(page.getByTestId(`station-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("station-fryer")).toContainText(/Fryer/i);
    await expect(page.getByTestId("station-prepa")).toContainText(/Prepa/i);

    // --- Scenario D (partial): traffic meters for six ---
    await expect(page.getByTestId("traffic-meters")).toBeVisible();
    await expect(page.getByTestId("meter-fryer")).toBeVisible({
      timeout: 20_000,
    });
    for (const id of [
      "fryer",
      "tortilla",
      "birria",
      "taquero",
      "carne",
      "prepa",
    ]) {
      await expect(page.getByTestId(`meter-${id}`)).toBeVisible();
    }
    const trafficToggle = page.getByTestId("traffic-toggle");
    await trafficToggle.scrollIntoViewIfNeeded();
    await trafficToggle.click({ force: true });
    await expect(trafficToggle).toBeChecked({ timeout: 5_000 });

    // --- Scenario B: assign uniqueness ---
    await page.getByTestId("hour-12").click();
    const available = page.getByTestId("available-list").locator("button");
    await expect(available.first()).toBeVisible({ timeout: 30_000 });

    await available.first().click();
    await page.getByTestId("station-fryer").getByRole("button").first().click();
    await expect(page.getByTestId("toast")).toContainText(/Assigned/i, {
      timeout: 15_000,
    });

    // Second person to fryer should fail (station full)
    const count = await available.count();
    if (count >= 2) {
      await available.nth(1).click();
      await page.getByTestId("station-fryer").getByRole("button").first().click();
      await expect(page.getByTestId("toast")).toContainText(
        /STATION_FULL|Assign rejected|full/i,
        { timeout: 15_000 },
      );
    }

    // --- Scenario C: Kitchen tarea + suggestions ---
    await expect(page.getByTestId("tareas-panel")).toBeVisible();
    await page
      .getByTestId("tarea-template-select")
      .selectOption("prep_salsa_bar");
    const suggestBtn = page.locator("[data-testid^='suggest-']").first();
    await expect(suggestBtn).toBeVisible({ timeout: 15_000 });
    await expect(suggestBtn).toContainText(/top|next/i);
    await suggestBtn.click();
    await expect(page.getByTestId("toast")).toContainText(/Tarea assigned/i, {
      timeout: 15_000,
    });
    await expect(
      page.getByTestId("tareas-working").locator("li"),
    ).not.toHaveCount(0);

    const doneBtn = page.locator("[data-testid^='tarea-done-']").first();
    await doneBtn.click();
    await expect(page.getByTestId("tareas-done").locator("li")).not.toHaveCount(
      0,
    );

    // --- Scenario E: hours ledger shows station minutes ---
    // Re-select the fryer assignee so ledger binds to someone with station time
    await page.getByTestId("assignee-fryer").click();
    const ledger = page.getByTestId("hours-ledger");
    await expect(ledger).toBeVisible();
    await expect(page.getByTestId("hours-ledger-rows")).toBeVisible({
      timeout: 15_000,
    });
    // Tarea minutes appear when any tarea time has accrued
    const tareaRows = page.getByTestId("hours-ledger-tarea-rows");
    if (await tareaRows.count()) {
      await expect(tareaRows).toBeVisible();
    }

    // Performance panel present
    await expect(page.getByTestId("performance-panel")).toBeVisible();

    // --- Scenario F: Cashiers regression ---
    await page.getByTestId("board-toggle-caja").click();
    await expect(page.getByTestId("station-yellow")).toBeVisible();
    await expect(page.getByTestId("traffic-meters")).toBeVisible();
    await expect(page.getByTestId("meter-cliente")).toBeVisible();
    await expect(page.getByTestId("tareas-panel")).toBeVisible();
    await page.getByTestId("tarea-template-select").selectOption("salsa");
    await expect(page.locator("[data-testid^='suggest-']").first()).toBeVisible(
      { timeout: 15_000 },
    );
  });
});
