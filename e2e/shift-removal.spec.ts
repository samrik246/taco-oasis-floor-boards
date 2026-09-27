import { test, expect } from "@playwright/test";

test("only an unlocked manager can see shift removal controls", async ({ page }) => {
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
