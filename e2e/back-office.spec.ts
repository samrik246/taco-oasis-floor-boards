import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

async function shot(page: import("@playwright/test").Page, name: string) {
  const dir = process.env.STORE_MEDIA;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
}

test("back office login, edit a station, see it on the wall", async ({ page }) => {
  await page.goto("/back-office");
  await page.getByTestId("back-office-code").fill("0000");
  await page.getByTestId("back-office-submit").click();
  await expect(page.getByTestId("back-office-error")).toBeVisible();

  await page.getByTestId("back-office-code").fill("2468");
  await page.getByTestId("back-office-submit").click();
  await expect(page.getByTestId("back-office-app")).toBeVisible();
  await expect(page.getByTestId("back-office-manager")).toContainText(/Ana Rivera/i);

  await page.getByTestId("back-office-tab-managers").click();
  await expect(page.getByTestId("manager-Ana Rivera")).toBeVisible();
  await expect(page.getByTestId("manager-list")).not.toContainText(/2468|codeHash/);

  await page.getByTestId("back-office-tab-stations").click();
  await page.getByTestId("station-label-yellow").fill("Yellow Lane");
  await page.getByTestId("station-save-yellow").click();
  await expect(page.getByTestId("back-office-toast")).toContainText(/Saved yellow/i);
  await shot(page, "back-office.png");

  await page.getByTestId("back-office-tab-sales").click();
  await expect(page.getByTestId("sales-hour-12")).toBeVisible();
  const noon = page.getByTestId("sales-hour-12");
  const original = await noon.inputValue();
  await noon.fill("1");
  await page.getByTestId("sales-save").click();
  await expect(page.getByTestId("back-office-error")).toContainText(/about 100%/i);
  await noon.fill(original);

  await page.goto("/?wall=1");
  await expect(page.getByTestId("wall-board")).toHaveAttribute("data-locale", "en");
  await expect(page.getByTestId("wall-station-yellow")).toContainText("Yellow Lane");
  await expect(page.getByTestId("load-sample")).toHaveCount(0);

  await page.goto("/back-office");
  await expect(page.getByTestId("station-label-yellow")).toBeVisible();
  await page.getByTestId("station-label-yellow").fill("Yellow / Outside");
  await page.getByTestId("station-save-yellow").click();
  await expect(page.getByTestId("back-office-toast")).toContainText(/Saved yellow/i);
});
