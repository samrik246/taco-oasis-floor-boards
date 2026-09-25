import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

async function shot(page: Page, name: string) {
  const dir = process.env.STORE_MEDIA;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, name),
    fullPage: true,
  });
}

async function unlockManager(page: Page) {
  if (await page.getByTestId("exit-manager").isVisible().catch(() => false)) return;
  await page.getByTestId("enter-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("role-badge")).toContainText(/Ana Rivera/i);
}

async function lockManager(page: Page) {
  const exit = page.getByTestId("exit-manager");
  if (await exit.isVisible().catch(() => false)) {
    await exit.click();
    await expect(page.getByTestId("role-badge")).toContainText(/Staff|Personal/i);
  }
}

/**
 * Planner D replaced the raw <select> date picker with prev/next arrows over
 * the imported date list. Walk to the target date reading the bar's own
 * data-date (YYYY-MM-DD sorts lexicographically, so string compare is enough).
 */
async function selectDate(page: Page, targetYmd: string) {
  const bar = page.getByTestId("date-bar");
  for (let i = 0; i < 60; i++) {
    const current = await bar.getAttribute("data-date");
    if (current === targetYmd) return;
    if (!current || current < targetYmd) {
      await page.getByTestId("date-next").click();
    } else {
      await page.getByTestId("date-prev").click();
    }
  }
  throw new Error(`selectDate: could not reach ${targetYmd}`);
}

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
    // Planner C: the floor language is a device preference, default Spanish,
    // independent of the board — not board-derived like Wall mode still is.
    await expect(page.getByTestId("floor-board")).toHaveAttribute(
      "data-locale",
      "es",
    );

    await page.getByTestId("locale-toggle-en").click();
    await expect(page.getByTestId("floor-board")).toHaveAttribute(
      "data-locale",
      "en",
    );
    await page.reload();
    await expect(page.getByTestId("floor-board")).toHaveAttribute(
      "data-locale",
      "en",
    );

    await unlockManager(page);
    await page.getByTestId("load-sample").click();
    await expect(page.getByTestId("toast")).toContainText(/Loaded sample|Muestra cargada/i, {
      timeout: 60_000,
    });
    await lockManager(page);

    await page.getByTestId("board-toggle-caja").click();
    await selectDate(page, "2026-09-20");
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
    await page.getByTestId("schedule-sort-time").click();
    await expect(page.getByTestId("schedule-panel")).toHaveAttribute(
      "data-sort",
      "time",
    );
    await expect(page.getByTestId("schedule-start").first()).toBeVisible();
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
    await expect(page.getByTestId("rush-panel")).toHaveAttribute(
      "data-metric",
      "percent-of-day",
    );
    await expect(page.getByTestId("rush-hour-12")).toContainText(/% of day/i);
    await expect(page.getByTestId("rush-basis")).toContainText(/not order counts/i);
    await shot(page, "rush-percent.png");
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
    await expect(trafficToggle).toBeDisabled();
    await unlockManager(page);
    await expect(trafficToggle).toBeEnabled({ timeout: 15_000 });
    await trafficToggle.click({ force: true });
    await expect(trafficToggle).toBeChecked({ timeout: 5_000 });
    await expect(page.getByTestId("toast")).toContainText(/Training on|Entrenamiento encendido/i, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("meter-cliente")).toBeVisible();
    await lockManager(page);

    await page.getByTestId("hour-12").click();

    const available = page.getByTestId("available-list").locator("button");
    await expect(available.first()).toBeVisible({ timeout: 30_000 });

    await available.first().click();
    await page.getByTestId("station-yellow").getByRole("button").first().click();

    // Planner F: assign feedback shows on the tapped station card, not the
    // top banner.
    await expect(page.getByTestId("station-feedback-yellow")).toContainText(
      /Assigned|Asignado/i,
      { timeout: 15_000 },
    );

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
    // Planner F: clear feedback also shows on the station card.
    await expect(page.getByTestId("station-feedback-yellow")).toContainText(
      /Cleared|Liberado/i,
      { timeout: 15_000 },
    );

    // Kitchen board: Spanish UI + stations + traffic + tareas
    // Locale is a device preference now, not board-derived — switch it back
    // to Spanish explicitly before asserting the cocina section is Spanish.
    await page.getByTestId("locale-toggle-es").click();
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
    await expect(page.getByTestId("schedule-sort-time")).toContainText(
      /Por hora/i,
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
    await expect(page.getByTestId("rush-hour-12")).toContainText(/% del día/i);
    await expect(page.getByTestId("rush-basis")).toContainText(/no son pedidos/i);
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

    await page.goto("/?wall=1");
    await expect(page.getByTestId("wall-board")).toHaveAttribute("data-locale", "en");
    await expect(page.getByTestId("wall-station-yellow")).toBeVisible();
    await expect(page.getByTestId("load-sample")).toHaveCount(0);
    await shot(page, "wall-mode-caja.png");
    await page.goto("/?wall=1&board=cocina");
    await expect(page.getByTestId("wall-board")).toHaveAttribute("data-locale", "es");
    await expect(page.getByTestId("wall-station-fryer")).toBeVisible();
    await expect(page.getByTestId("wall-station-fryer")).toContainText(/Freidora|Fryer/i);

    // Readonly mode still blocks mutations
    await page.goto("/?readonly=1");
    await expect(page.getByTestId("readonly-badge")).toBeVisible();
    await expect(page.getByTestId("load-sample")).toBeDisabled();
    await expect(page.getByTestId("traffic-toggle")).toBeDisabled();
  });
});
