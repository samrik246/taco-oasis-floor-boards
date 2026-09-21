import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 1 + Kitchen smoke: Cashiers path + Kitchen toggle/stations/traffic/tareas.
 * Uses fresh disposable DB (prisma/e2e.db) via playwright webServer.
 * Also covers bilingual cocina UI, timeline view, manager unlock + idle timeout.
 */
test.describe("phase 1 cashiers + kitchen smoke", () => {
  test("load sample, cashiers flow, kitchen board extras", async ({ page }) => {
    const e2eDb = path.resolve(process.cwd(), "prisma/e2e.db");
    expect(fs.existsSync(e2eDb)).toBe(true);

    await page.goto("/");

    await expect(page.getByTestId("floor-board")).toBeVisible();
    await expect(page.getByTestId("readonly-badge")).toHaveCount(0);
    await expect(page.getByTestId("role-badge")).toContainText(/Staff|Personal/i);
    await expect(page.getByTestId("floor-board")).toHaveAttribute(
      "data-locale",
      "en",
    );

    await page.getByTestId("load-sample").click();
    await expect(page.getByTestId("toast")).toContainText(/Loaded sample|Muestra cargada/i, {
      timeout: 60_000,
    });

    await page.getByTestId("board-toggle-caja").click();
    await page.getByTestId("date-select").selectOption("2026-09-20");
    await expect(page.getByTestId("station-grid")).toBeVisible();
    await expect(page.getByTestId("traffic-meters")).toBeVisible();
    await expect(page.getByTestId("tareas-panel")).toBeVisible();

    // Timeline first-class view
    await page.getByTestId("view-toggle-timeline").click();
    await expect(page.getByTestId("timeline-panel")).toBeVisible();
    await expect(page.getByTestId("timeline-matrix")).toBeVisible({
      timeout: 15_000,
    });

    // Schedule first-class view (all day)
    await page.getByTestId("view-toggle-schedule").click();
    await expect(page.getByTestId("schedule-panel")).toBeVisible();
    await expect(page.getByTestId("schedule-grid")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("schedule-mode-all-day")).toBeVisible();
    await expect(page.getByTestId("schedule-headcount-row")).toBeVisible();
    await expect(page.getByTestId("schedule-hour-7")).toBeVisible();
    await expect(page.locator("[data-station-banner='true']")).toHaveCount(0);
    await expect(page.locator("[data-testid^='schedule-group-']")).toHaveCount(0);
    await expect(page.getByTestId("schedule-panel")).toHaveAttribute(
      "data-sort",
      "name",
    );
    const positionBlock = page.locator("[data-text-kind='position']").first();
    await expect(positionBlock).toBeVisible();
    await expect(positionBlock).toHaveText(
      (await positionBlock.getAttribute("data-code")) ?? "",
    );
    await page.getByTestId("schedule-sort-position").click();
    await expect(page.getByTestId("schedule-panel")).toHaveAttribute(
      "data-sort",
      "position",
    );
    const personBlock = page.locator("[data-text-kind='person']").first();
    await expect(personBlock).toBeVisible();
    const personName = (await personBlock.getAttribute("data-person")) ?? "";
    const shown = (await personBlock.innerText()).trim();
    expect(personName.startsWith(shown.split(/\s+/)[0] ?? "___")).toBe(true);
    expect(shown).not.toBe((await personBlock.getAttribute("data-code")) ?? "");
    await expect(page.locator("[data-section-kind='thin']").first()).toBeVisible();
    await expect(page.locator("[data-station-banner='true']")).toHaveCount(0);
    await page.getByTestId("schedule-sort-name").click();

    await page.getByTestId("schedule-mode-rest-of-day").click();
    await expect(page.getByTestId("schedule-panel")).toHaveAttribute(
      "data-mode",
      "rest-of-day",
    );
    await expect(page.getByTestId("schedule-rest-rule")).toBeVisible();

    for (const id of ["board", "timeline", "schedule", "tareas", "rush"]) {
      await expect(page.getByTestId(`view-toggle-${id}`)).toBeVisible();
    }
    await page.getByTestId("view-toggle-rush").click();
    await expect(page.getByTestId("rush-panel")).toBeVisible();
    await expect(page.getByTestId("rush-summary")).toContainText(
      /Gets busier around 12p/i,
    );
    await expect(page.getByTestId("rush-prep")).toContainText(
      /Prep before the rush/i,
    );
    await expect(page.getByTestId("rush-basis")).toContainText(
      /historical sales/i,
    );
    await expect(page.getByTestId("rush-hour-12")).toHaveAttribute(
      "data-rush",
      "true",
    );
    await expect(page.getByTestId("rush-hour-18")).toHaveAttribute(
      "data-rush",
      "true",
    );
    await expect(page.getByTestId("rush-hour-10")).toHaveAttribute(
      "data-rush",
      "false",
    );
    await expect(page.getByTestId("rush-hour-7")).toBeVisible();
    await expect(page.getByTestId("rush-hour-21")).toBeVisible();

    await page.getByTestId("view-toggle-board").click();
    await expect(page.getByTestId("station-grid")).toBeVisible();

    const trafficToggle = page.getByTestId("traffic-toggle");
    await trafficToggle.scrollIntoViewIfNeeded();
    await expect(trafficToggle).toBeEnabled({ timeout: 15_000 });
    await trafficToggle.click({ force: true });
    await expect(trafficToggle).toBeChecked({ timeout: 5_000 });
    await expect(page.getByTestId("toast")).toContainText(/Simulator on|Simulador encendido/i, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("meter-cliente")).toBeVisible();

    await page.getByTestId("hour-12").click();

    const available = page.getByTestId("available-list").locator("button");
    await expect(available.first()).toBeVisible({ timeout: 30_000 });

    await available.first().click();
    await page.getByTestId("station-yellow").getByRole("button").first().click();

    await expect(page.getByTestId("toast")).toContainText(/Assigned|Asignado/i, {
      timeout: 15_000,
    });

    await page.getByTestId("tarea-template-select").selectOption("salsa");
    const suggestBtn = page.locator("[data-testid^='suggest-']").first();
    await expect(suggestBtn).toBeVisible({ timeout: 15_000 });
    await suggestBtn.click();
    await expect(page.getByTestId("toast")).toContainText(/Tarea assigned|Tarea asignada/i, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("tareas-working").locator("li")).not.toHaveCount(
      0,
    );

    // Manager unlock required to clear with reason
    await page.getByTestId("enter-manager").click();
    await expect(page.getByTestId("manager-unlock-modal")).toBeVisible();
    await page.getByTestId("manager-code-input").fill("0000");
    await page.getByTestId("manager-unlock-submit").click();
    await expect(page.getByTestId("manager-code-error")).toContainText(
      /Wrong code|Código incorrecto/i,
    );
    await page.getByTestId("manager-code-input").fill("2468");
    await page.getByTestId("manager-unlock-submit").click();
    await expect(page.getByTestId("role-badge")).toContainText(/Ana Rivera/i, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("manager-notes")).toBeVisible();
    await expect(page.getByTestId("hours-ledger")).toBeVisible();

    await page.getByTestId("clear-yellow").click();
    await expect(page.getByTestId("move-reason-modal")).toBeVisible();
    await page.getByTestId("move-reason-select").selectOption("Break");
    await page.getByTestId("move-reason-confirm").click();
    await expect(page.getByTestId("toast")).toContainText(/Cleared|Liberado/i, {
      timeout: 15_000,
    });

    // Kitchen board: Spanish UI + stations + traffic + tareas
    await page.getByTestId("board-toggle-cocina").click();
    await expect(page.getByTestId("floor-board")).toHaveAttribute(
      "data-locale",
      "es",
    );
    await expect(page.getByTestId("station-fryer")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("station-fryer")).toContainText(/Freidora|Fryer/i);
    await expect(page.getByTestId("station-tortilla")).toBeVisible();
    await expect(page.getByTestId("station-birria")).toBeVisible();
    await expect(page.getByTestId("station-taquero")).toBeVisible();
    await expect(page.getByTestId("station-carne")).toBeVisible();
    await expect(page.getByTestId("station-prepa")).toBeVisible();
    await expect(page.getByTestId("traffic-meters")).toBeVisible();
    await expect(page.getByTestId("meter-fryer")).toBeVisible();
    await expect(page.getByTestId("tareas-panel")).toBeVisible();
    await expect(page.getByTestId("tarea-template-select")).toContainText(
      /Reponer tortillas|Restock tortillas|Prep salsa|Preparar/i,
    );

    await page.getByTestId("view-toggle-timeline").click();
    await expect(page.getByTestId("timeline-panel")).toBeVisible();
    await expect(page.getByTestId("timeline-title").or(page.getByTestId("timeline-panel"))).toBeVisible();

    // Cocina Schedule UI is Spanish
    await page.getByTestId("view-toggle-schedule").click();
    await expect(page.getByTestId("schedule-panel")).toHaveAttribute(
      "data-locale",
      "es",
    );
    await expect(page.getByTestId("schedule-mode-all-day")).toContainText(
      /Todo el día/i,
    );
    await expect(page.getByTestId("schedule-mode-rest-of-day")).toContainText(
      /Resto del día/i,
    );
    await expect(page.getByTestId("schedule-title")).toContainText(/Horario/i);
    await expect(page.getByTestId("schedule-grid")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("[data-station-banner='true']")).toHaveCount(0);
    await expect(page.locator("[data-text-kind='position']").first()).toBeVisible();
    await expect(page.getByTestId("schedule-sort-name")).toContainText(
      /Por nombre/i,
    );
    await expect(page.getByTestId("schedule-sort-position")).toContainText(
      /Por puesto/i,
    );

    await page.getByTestId("view-toggle-rush").click();
    await expect(page.getByTestId("view-toggle-rush")).toContainText(
      /Más ocupado/i,
    );
    await expect(page.getByTestId("rush-panel")).toHaveAttribute(
      "data-locale",
      "es",
    );
    await expect(page.getByTestId("rush-summary")).toContainText(/más ocupado/i);
    await expect(page.getByTestId("rush-basis")).toContainText(
      /ventas históricas/i,
    );
    await expect(page.getByTestId("rush-prep")).toContainText(/antes del rush/i);
    await expect(page.getByTestId("rush-hour-12")).toHaveAttribute(
      "data-rush",
      "true",
    );
    await expect(page.getByTestId("rush-hour-19")).toHaveAttribute(
      "data-rush",
      "true",
    );

    // Idle timeout returns to staff (MANAGER_IDLE_MS=1500 in playwright config)
    await page.getByTestId("view-toggle-board").click();
    await expect(page.getByTestId("role-badge")).toContainText(/Ana Rivera|Gerente/i);
    await page.waitForTimeout(2200);
    await expect(page.getByTestId("floor-board")).toHaveAttribute(
      "data-role",
      "staff",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("manager-notes")).toHaveCount(0);
    await expect(page.getByTestId("enter-manager")).toBeVisible();

    // Readonly mode still blocks mutations
    await page.goto("/?readonly=1");
    await expect(page.getByTestId("readonly-badge")).toBeVisible();
    await expect(page.getByTestId("load-sample")).toBeDisabled();
    await expect(page.getByTestId("traffic-toggle")).toBeDisabled();
  });
});
