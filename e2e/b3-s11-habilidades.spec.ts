import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const ada = "b3s11-ada-moss";
const bea = "b3s11-bea-moss";

async function keepDesk(page: Page) {
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const json = await response.json();
    json.idleMs = 120_000;
    await route.fulfill({ response, json });
  });
}

test.beforeAll(async () => {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
  });
  const owner = await prisma.manager.updateMany({
    where: { name: "Sam Chen" },
    data: { role: "owner" },
  });
  if (owner.count !== 1) throw new Error(`expected one Sam Chen owner, updated ${owner.count}`);
  for (const [externalId, firstName] of [[ada, "Ada"], [bea, "Bea"]] as const) {
    const existing = await prisma.employee.findUnique({ where: { externalId } });
    if (existing) {
      await prisma.shift.deleteMany({ where: { employeeId: existing.id } });
      await prisma.employee.delete({ where: { id: existing.id } });
    }
    const person = await prisma.employee.create({
      data: { externalId, firstName, lastName: "Moss" },
    });
    await prisma.shift.create({
      data: {
        employeeId: person.id,
        date: "2038-05-02",
        startAt: new Date("2038-05-02T14:00:00.000Z"),
        endAt: new Date("2038-05-02T22:00:00.000Z"),
        sourcePosition: "Cocina",
        board: "cocina",
      },
    });
  }
  await prisma.abilityColumnSetting.deleteMany({ where: { key: "pdf_pstl" } });
  await prisma.$disconnect();
});

test("L1 rows alternate, headers use the station colour, and hide comes back faded", async ({ page }) => {
  await keepDesk(page);
  await page.goto("/back-office");
  await page.getByTestId("back-office-code").fill("8642");
  await page.getByTestId("back-office-submit").click();
  await page.getByTestId("back-office-tab-habilidades").click();
  await expect(page.getByTestId("abilities-grid")).toBeVisible();

  const rows = page.locator("[data-testid^='ability-person-']");
  await expect(rows.nth(1)).toBeVisible();
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(1);
  for (let index = 0; index < Math.min(rowCount, 8); index += 1) {
    const even = index % 2 === 0;
    await expect(rows.nth(index)).toHaveAttribute("data-stripe", even ? "white" : "grey");
    await expect(rows.nth(index).locator("[data-testid^='ability-name-']")).toHaveClass(even ? /bg-white/ : /bg-neutral-200/);
  }
  const pasteles = page.getByTestId("ability-header-pdf_pstl");
  await expect(pasteles).toHaveClass(/bg-purple-200/);
  await expect(pasteles).toHaveClass(/text-purple-950/);
  await page.screenshot({ path: "test-results/s11-habilidades-grid.png", fullPage: true });

  await page.getByTestId("ability-hide-pdf_pstl").click();
  await expect(pasteles).toHaveCount(0);
  await page.getByTestId("ability-show-hidden").click();
  await expect(page.getByTestId("ability-header-pdf_pstl")).toHaveClass(/opacity-40/);
  await page.getByTestId("ability-hide-pdf_pstl").click();
  await expect(page.getByTestId("ability-header-pdf_pstl")).toBeVisible();
  await expect(page.getByTestId("ability-header-pdf_pstl")).not.toHaveClass(/opacity-40/);
});
