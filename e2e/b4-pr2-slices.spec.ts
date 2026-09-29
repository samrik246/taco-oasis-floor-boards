import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";

const date = "2035-04-08";
const people = [
  { externalId: "b4pr2-caja", firstName: "Caja", lastName: "Quarter", board: "caja", stationId: "green1" },
  { externalId: "b4pr2-cocina", firstName: "Cocina", lastName: "Quarter", board: "cocina", stationId: "pdf_tq1r" },
] as const;

function chicago(clock: string): Date {
  return fromZonedTime(`${date}T${clock}`, "America/Chicago");
}

async function unlock(page: Page) {
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
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
    const shift = await prisma.shift.create({
      data: {
        employeeId: employee.id,
        date,
        board: person.board,
        sourcePosition: person.board === "caja" ? "Caja" : "Cocina",
        startAt: chicago("11:00:00"),
        endAt: chicago("15:30:00"),
      },
    });
    await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId: employee.id,
        stationId: person.stationId,
        hourStart: chicago("15:00:00"),
        hourEnd: chicago("16:00:00"),
      },
    });
  }
  await prisma.$disconnect();
});

test("a 3:30 shift end shows 3:30 and 3:45 open on caja and cocina", async ({ page }) => {
  await unlock(page);
  for (const person of people) {
    await page.getByTestId("compact-board").selectOption(person.board);
    await page.getByTestId("compact-date").selectOption(date);
    await page.getByTestId("compact-view").selectOption("timeline");
    const row = page.getByRole("row").filter({ hasText: person.firstName });
    await expect(row).toBeVisible();
    const cell = row.locator("[data-testid^='paint-cell-'][data-testid$='-15']");
    await expect(cell).toContainText("3:30");
    await expect(cell).toContainText("3:45");
    await expect(page.getByTestId("huecos-count")).toBeVisible();
  }
});
