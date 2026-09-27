import { test, expect, type Page } from "@playwright/test";

async function managerPage(page: Page, code = "2468") {
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
  });
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill(code);
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("shift-removal-panel")).toBeVisible();
}

test("only an unlocked manager can see shift removal controls", async ({ page }) => {
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
  });
  await page.goto("/");
  await expect(page.getByTestId("shift-removal-panel")).toHaveCount(0);
  const denied = await page.request.get("/api/shift-removals?board=caja&date=2026-09-20");
  expect(denied.status()).toBe(401);

  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("shift-removal-panel")).toBeVisible();
  await expect(page.getByTestId("shift-removal-panel")).toContainText("Quitar o restaurar turno");

  await page.getByTestId("compact-manager").click();
  await expect(page.getByTestId("shift-removal-panel")).toHaveCount(0);
});

test("a second manager's stale removal cannot remove the same shift twice", async ({ page, browser }) => {
  await managerPage(page);
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
  await page.getByTestId("compact-date").selectOption("2026-09-20");
  await page.getByTestId("compact-view").selectOption("timeline");
  const row = page.getByTestId("shift-removal-panel").locator("[data-testid^='shift-removal-row-']").first();
  await expect(row).toBeVisible();
  const rowId = await row.getAttribute("data-testid");
  expect(rowId).toMatch(/^shift-removal-row-/);

  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await managerPage(second, "1357");
  await second.getByTestId("compact-date").selectOption("2026-09-20");
  await second.getByTestId("compact-view").selectOption("timeline");
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
