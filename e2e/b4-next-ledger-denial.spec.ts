import { test, expect } from "@playwright/test";
import { seedTodayPeople } from "./today-fixture";

test("ordinary manager sees an honest weekly-hours restriction, never zero hours", async ({ page }) => {
  await seedTodayPeople("ledger-denial");
  await page.route("**/api/managers", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
  });
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
  await page.getByTestId("compact-board").selectOption("cocina");
  await page.getByTestId("compact-view").selectOption("board");
  await page.getByTestId("compact-hour").selectOption("9");
  const denied = page.waitForResponse(r => r.url().includes("/hours?") && r.status() === 403);
  await page.locator("button[data-testid^='available-']").first().click();
  await denied;
  const panel = page.getByTestId("hours-ledger");
  await expect(panel).toContainText(/Solo el propietario|Only the owner/);
  await expect(page.getByTestId("hours-ledger-empty")).toHaveCount(0);
  await expect(page.getByTestId("hours-ledger-rows")).toHaveCount(0);
  await expect(panel).not.toContainText("0h");
});
