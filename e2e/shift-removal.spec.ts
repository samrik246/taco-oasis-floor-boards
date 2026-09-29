import { test, expect, type Page } from "@playwright/test";

async function openTurnos(page: Page, code = "2468") {
  await page.goto("/back-office");
  await page.getByTestId("back-office-code").fill(code);
  await page.getByTestId("back-office-submit").click();
  await expect(page.getByTestId("back-office-app")).toBeVisible();
  await page.getByTestId("back-office-tab-turnos").click();
  await expect(page.getByTestId("shift-removal-panel")).toBeVisible();
}

test("the board no longer shows shift removal, and Turnos does after a desk login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("shift-removal-panel")).toHaveCount(0);
  const denied = await page.request.get("/api/shift-removals?board=caja&date=2026-09-20");
  expect(denied.status()).toBe(401);

  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("shift-removal-panel")).toHaveCount(0);

  await openTurnos(page);
  await expect(page.getByTestId("shift-removal-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-testid^='shift-removal-row-']")).toHaveCount(0);
  await expect(page.getByTestId("shift-removal-panel")).toContainText("Quitar o restaurar turno");

  await page.getByTestId("back-office-logout").click();
  await expect(page.getByTestId("shift-removal-panel")).toHaveCount(0);
});

test("the removal line stays closed and names how many shifts are removed", async ({ page }) => {
  await page.route("**/api/shift-removals?*", async (route) => {
    await route.fulfill({
      json: {
        removals: [
          { id: "removed-1", state: "removed" },
          { id: "removed-2", state: "removed" },
          { id: "resolved-1", state: "resolved" },
        ],
      },
    });
  });
  await openTurnos(page);
  await expect(page.getByTestId("shift-removal-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("shift-removal-panel")).toContainText("Quitar o restaurar turno (2 quitados)");
  await expect(page.locator("[data-testid^='shift-removal-row-']")).toHaveCount(0);
  await expect(page.locator("[data-testid^='removed-shift-']")).toHaveCount(0);
});

test("a second manager's stale removal cannot remove the same shift twice", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  const session = await page.request.post("/api/managers", { data: { code: "2468" } });
  expect(session.ok()).toBe(true);
  const { sessionToken } = await session.json() as { sessionToken: string };
  const datesResponse = await page.request.get("/api/days", {
    headers: { "x-manager-session": sessionToken },
  });
  const dates = await datesResponse.json() as { dates: string[] };
  if (!dates.dates.includes("2026-09-20")) {
    await page.getByTestId("toolbar-more").click();
    await page.getByTestId("load-sample").click();
    await expect(page.getByTestId("toast")).toContainText(/Loaded sample|Muestra cargada/i,
      { timeout: 60_000 });
    await page.getByTestId("toolbar-more").click();
  }

  await openTurnos(page);
  await page.getByTestId("turnos-date").fill("2026-09-20");
  await page.getByTestId("shift-removal-toggle").click();
  const row = page.getByTestId("shift-removal-panel").locator("[data-testid^='shift-removal-row-']").first();
  await expect(row).toBeVisible();
  const rowId = await row.getAttribute("data-testid");
  expect(rowId).toMatch(/^shift-removal-row-/);

  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await openTurnos(second, "1357");
  await second.getByTestId("turnos-date").fill("2026-09-20");
  await second.getByTestId("shift-removal-toggle").click();
  const staleRow = second.getByTestId(rowId!);
  await expect(staleRow).toBeVisible();
  await staleRow.getByRole("button", { name: "Quitar turno" }).click();
  await second.getByTestId("shift-removal-reason").fill("Manager B stale action");

  await row.getByRole("button", { name: "Quitar turno" }).click();
  await page.getByTestId("shift-removal-reason").fill("Manager A correction");
  await page.getByTestId("shift-removal-submit").click();
  await expect(page.getByTestId("shift-removal-feedback")).toContainText("Turno quitado");

  await second.getByTestId("shift-removal-submit").click();
  await expect(second.getByTestId("shift-removal-feedback")).toContainText("shift changed");
  await expect(second.getByTestId(rowId!)).toHaveCount(0);
  await secondContext.close();
});
