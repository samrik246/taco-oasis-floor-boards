import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const ownerBadge = /Owner - 5 min|Dueño - 5 min/;

test.beforeAll(async () => {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
  });
  const updated = await prisma.manager.updateMany({
    where: { name: "Sam Chen" },
    data: { role: "owner" },
  });
  if (updated.count !== 1) {
    throw new Error(`expected one Sam Chen row to become owner, updated ${updated.count}`);
  }
  await prisma.$disconnect();
});

async function unlockFloor(page: Page, code: string) {
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill(code);
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
}

test("manager unlock hides owner screens and the desk does not idle", async ({ page }) => {
  await page.goto("/back-office");
  await page.getByTestId("back-office-code").fill("2468");
  await page.getByTestId("back-office-submit").click();
  await expect(page.getByTestId("back-office-app")).toBeVisible();
  await expect(page.getByTestId("back-office-tab-managers")).toHaveCount(0);
  await expect(page.getByTestId("back-office-tab-cambios")).toHaveCount(0);
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("back-office-app")).toBeVisible();
  await expect(page.getByTestId("back-office-code")).toHaveCount(0);
});

test("owner unlock sees Managers and desk idle clears the token", async ({ page }) => {
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const json = await response.json();
    if (json?.manager?.role === "owner") json.idleMs = 2500;
    await route.fulfill({ response, json });
  });

  await page.goto("/back-office");
  await page.getByTestId("back-office-code").fill("8642");
  await page.getByTestId("back-office-submit").click();
  await expect(page.getByTestId("back-office-tab-managers")).toBeVisible();
  await page.getByTestId("back-office-tab-managers").click();
  await expect(page.getByTestId("manager-list")).toBeVisible();
  await expect(page.getByTestId("manager-list")).not.toContainText(/2468|8642|codeHash/);
  await expect(page.getByTestId("back-office-tab-cambios")).toBeVisible();

  await expect(page.getByTestId("back-office-code")).toBeVisible({ timeout: 8000 });
  const stored = await page.evaluate(() => sessionStorage.getItem("taco-oasis-back-office-session"));
  expect(stored).toBeNull();
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/admin/managers");
    return res.status;
  });
  expect(status).toBe(401);
});

test("owner badge says Owner - 5 min and a manager badge does not", async ({ page }) => {
  await unlockFloor(page, "8642");
  await page.getByTestId("toolbar-more").click();
  await expect(page.getByTestId("role-badge")).toContainText(ownerBadge);
  await page.getByTestId("compact-manager").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
  await unlockFloor(page, "2468");
  await page.getByTestId("toolbar-more").click();
  await expect(page.getByTestId("role-badge")).toContainText(/Manager:|Gerente:/);
  await expect(page.getByTestId("role-badge")).not.toContainText(ownerBadge);
});
