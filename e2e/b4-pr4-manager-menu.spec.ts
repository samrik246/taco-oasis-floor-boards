import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

const today = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
const future = "2099-03-03";
const people = [
  { externalId: "b4pr4-caja", firstName: "Caja", lastName: "Menu", board: "caja", date: today },
  { externalId: "b4pr4-cocina", firstName: "Cocina", lastName: "Menu", board: "cocina", date: today },
  { externalId: "b4pr4-later", firstName: "Later", lastName: "Menu", board: "caja", date: future },
] as const;

function chicago(day: string, clock: string): Date {
  return fromZonedTime(`${day}T${clock}`, "America/Chicago");
}

async function unlock(page: Page, code = "2468") {
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill(code);
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
}

test.beforeAll(async () => {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
  });
  for (const person of people) {
    const existing = await prisma.employee.findUnique({ where: { externalId: person.externalId } });
    if (existing) {
      await prisma.assignment.deleteMany({ where: { employeeId: existing.id } });
      await prisma.shift.deleteMany({ where: { employeeId: existing.id } });
      await prisma.employee.delete({ where: { id: existing.id } });
    }
    const employee = await prisma.employee.create({
      data: { externalId: person.externalId, firstName: person.firstName, lastName: person.lastName },
    });
    await prisma.shift.create({
      data: {
        employeeId: employee.id,
        date: person.date,
        board: person.board,
        sourcePosition: person.board === "caja" ? "Caja" : "Cocina",
        startAt: chicago(person.date, "11:00:00"),
        endAt: chicago(person.date, "15:00:00"),
      },
    });
  }
  await prisma.$disconnect();
});

test("the menu is on today's caja and cocina boards and missing on a future day", async ({ page }) => {
  await unlock(page);
  for (const board of ["caja", "cocina"] as const) {
    await page.getByTestId("compact-board").selectOption(board);
    await page.getByTestId("compact-date").selectOption(today);
    await page.getByTestId("compact-view").selectOption("timeline");
    await expect(page.locator("[data-testid^='overlay-menu-']").first()).toBeVisible();
  }
  await page.getByTestId("compact-board").selectOption("caja");
  await expect(page.getByTestId("compact-date").locator(`option[value="${future}"]`)).toHaveCount(0);
  await unlock(page, "8642");
  await page.getByTestId("compact-date").selectOption(future);
  await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.locator("[data-testid^='overlay-menu-']")).toHaveCount(0);
});
