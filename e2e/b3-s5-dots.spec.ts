import { seedTodayPeople } from "./today-fixture";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";

const dotDate = "2034-11-06";
const people = [
  { externalId: "b3s5-ada-quinn", firstName: "Ada", lastName: "Quinn", level: "preferred" },
  { externalId: "b3s5-bea-ruiz", firstName: "Bea", lastName: "Ruiz", level: "training" },
  { externalId: "b3s5-cal-moss", firstName: "Cal", lastName: "Moss", level: "forbidden" },
] as const;
const covers = [
  { externalId: "b3s5-dee-park", firstName: "Dee", lastName: "Park", stationId: "pdf_tf1r" },
  { externalId: "b3s5-eli-nash", firstName: "Eli", lastName: "Nash", stationId: "pdf_pr1e" },
  { externalId: "b3s5-fox-birria", firstName: "Fox", lastName: "Birria", stationId: "pdf_br1a" },
] as const;

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

async function unlock(page: Page, code: string) {
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill(code);
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
}

async function openCocina(page: Page, date = dotDate) {
  await expect(page.getByTestId("compact-date").locator(`option[value="${date}"]`)).toHaveCount(1);
  await page.getByTestId("compact-date").selectOption(date);
  await page.getByTestId("compact-board").selectOption("cocina");
  await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("manager-color-editor")).toBeVisible();
  await page.getByTestId("paint-matrix").getByRole("button", { name: "12:00 pm", exact: true }).click();
}

async function rowId(page: Page, name: string) {
  const row = page.locator("[data-testid^='paint-row-']", { hasText: name });
  await expect(row).toHaveCount(1);
  const testId = await row.getAttribute("data-testid");
  return testId!.replace("paint-row-", "");
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
  const ids = [...people, ...covers].map((person) => person.externalId);
  const existing = await prisma.employee.findMany({ where: { externalId: { in: ids } } });
  const existingIds = existing.map((person) => person.id);
  if (existingIds.length > 0) {
    await prisma.assignment.deleteMany({ where: { employeeId: { in: existingIds } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: existingIds } } });
    await prisma.shift.deleteMany({ where: { employeeId: { in: existingIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: existingIds } } });
  }
  const startAt = fromZonedTime(`${dotDate}T09:00:00`, "America/Chicago");
  const endAt = fromZonedTime(`${dotDate}T17:00:00`, "America/Chicago");
  const hourStart = fromZonedTime(`${dotDate}T12:00:00`, "America/Chicago");
  const hourEnd = fromZonedTime(`${dotDate}T13:00:00`, "America/Chicago");
  for (const person of people) {
    const employee = await prisma.employee.create({
      data: {
        externalId: person.externalId,
        firstName: person.firstName,
        lastName: person.lastName,
        abilities: { create: [{ stationId: "pdf_tq1r", level: person.level }] },
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: employee.id,
        date: dotDate,
        startAt,
        endAt,
        sourcePosition: "Cocina",
        board: "cocina",
      },
    });
  }
  for (const person of covers) {
    const employee = await prisma.employee.create({
      data: { externalId: person.externalId, firstName: person.firstName, lastName: person.lastName },
    });
    const shift = await prisma.shift.create({
      data: {
        employeeId: employee.id,
        date: dotDate,
        startAt,
        endAt,
        sourcePosition: "Cocina",
        board: "cocina",
      },
    });
    await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId: employee.id,
        stationId: person.stationId,
        hourStart,
        hourEnd,
      },
    });
  }
  await prisma.$disconnect();
});

test("E3 owner dots at 12 are full, dim and absent, and a pending Taquero 1 paint clears them", async ({ page }) => {
  await keepDesk(page);
  await unlock(page, "8642");
  await openCocina(page);
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-show-levels", "1");

  const ada = await rowId(page, "Ada Quinn");
  const bea = await rowId(page, "Bea Ruiz");
  const cal = await rowId(page, "Cal Moss");
  const full = page.getByTestId(`eligibility-dot-${ada}-12-pdf_tq1r`);
  const dim = page.getByTestId(`eligibility-dot-${bea}-12-pdf_tq1r`);
  await expect(full).toHaveAttribute("data-level", "preferred");
  await expect(full).toHaveAttribute("data-mark", "filled");
  await expect(full.locator("span")).toHaveClass(/red-600/);
  await expect(full.locator("span")).toHaveClass(/ring-white/);
  await expect(dim).toHaveAttribute("data-level", "training");
  await expect(dim).toHaveAttribute("data-mark", "dashed");
  await expect(dim.locator("span")).toHaveClass(/border-dashed/);
  await expect(dim.locator("span")).toHaveClass(/ring-white/);
  await expect(page.getByTestId(`eligibility-dot-${cal}-12-pdf_tq1r`)).toHaveCount(0);
  await expect(page.locator("[data-testid$='-12-pdf_tq1r'][data-testid^='eligibility-dot-']")).toHaveCount(2);

  await expect(page.getByTestId(`paint-cell-${ada}-12`)).toHaveAttribute("aria-label", /TQ1R/);
  await expect(page.getByTestId(`paint-cell-${ada}-12`)).not.toHaveAttribute("aria-label", /entrenando/);
  await expect(page.getByTestId(`paint-cell-${bea}-12`)).toHaveAttribute("aria-label", /TQ1R entrenando/);
  await expect(page.getByTestId(`paint-cell-${cal}-12`)).not.toHaveAttribute("aria-label", /TQ1R/);

  await page.getByTestId("paint-palette-pdf_tq1r").click();
  await page.getByTestId(`paint-cell-${ada}-12`).click();
  await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
  await expect(page.locator("[data-testid$='-12-pdf_tq1r'][data-testid^='eligibility-dot-']")).toHaveCount(0);
  await expect(page.getByTestId(`eligibility-dot-${bea}-12-pdf_tq1r`)).toHaveCount(0);
  await expect(page.getByTestId(`eligibility-dot-${cal}-12-pdf_tq1r`)).toHaveCount(0);
  await expect(page.getByTestId(`eligibility-dot-${bea}-12-pdf_guia`)).toBeVisible();
  await expect(page.getByTestId(`eligibility-dot-${cal}-12-pdf_guia`)).toBeVisible();
});

test("E4 a manager payload has no dots or abilities, and an owner lock clears the dots", async ({ page }) => {
  const today = await seedTodayPeople("dotDate-today");
  const managerBodies: string[] = [];
  let watchManager = true;
  page.on("response", async (response) => {
    if (!watchManager || !response.ok()) return;
    if (!response.url().includes(`/api/boards/cocina/days/${today}`)) return;
    try {
      managerBodies.push(await response.text());
    } catch {
      /* a later reader took the body */
    }
  });

  await keepDesk(page);
  await unlock(page, "2468");
  await openCocina(page, today);
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-show-levels", "0");
  await expect(page.locator("[data-testid^='eligibility-dot-']")).toHaveCount(0);
  await expect.poll(() => managerBodies.length).toBeGreaterThan(0);
  for (const body of managerBodies) expect(body).not.toContain('"abilities"');

  watchManager = false;
  await unlock(page, "8642");
  await openCocina(page);
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-show-levels", "1");
  await expect(page.locator("[data-testid$='-12-pdf_tq1r'][data-testid^='eligibility-dot-']")).toHaveCount(2);

  await page.getByTestId("compact-manager").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-show-levels", "0");
  await expect(page.locator("[data-testid^='eligibility-dot-']")).toHaveCount(0);
  await expect(page.getByTestId("manager-color-editor")).toHaveCount(0);
});
