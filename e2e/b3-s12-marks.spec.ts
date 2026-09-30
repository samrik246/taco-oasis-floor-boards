import { seedTodayPeople } from "./today-fixture";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { stationColorClass } from "../src/components/board/board-helpers";
import { stationSolidClass } from "../src/lib/schedule/station-codes";

const markDate = "2034-12-02";
const people = [
  { externalId: "b3s12-noa-moss", firstName: "Noa", lastName: "Moss", level: "forbidden" },
  { externalId: "b3s12-pia-moss", firstName: "Pia", lastName: "Moss", level: "training" },
  { externalId: "b3s12-bea-moss", firstName: "Bea", lastName: "Moss", level: "ok" },
  { externalId: "b3s12-fia-moss", firstName: "Fia", lastName: "Moss", level: "preferred" },
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

async function openCocina(page: Page, date = markDate) {
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
  const ids = [...people.map((person) => person.externalId), "b3s12-painted-moss", "b3s12-grid-moss"];
  const existing = await prisma.employee.findMany({ where: { externalId: { in: ids } } });
  const existingIds = existing.map((person) => person.id);
  if (existingIds.length > 0) {
    await prisma.assignment.deleteMany({ where: { employeeId: { in: existingIds } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: existingIds } } });
    await prisma.shift.deleteMany({ where: { employeeId: { in: existingIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: existingIds } } });
  }
  await prisma.abilityColumnSetting.deleteMany({ where: { key: "pdf_crne" } });
  const startAt = fromZonedTime(`${markDate}T09:00:00`, "America/Chicago");
  const endAt = fromZonedTime(`${markDate}T17:00:00`, "America/Chicago");
  const hourStart = fromZonedTime(`${markDate}T12:00:00`, "America/Chicago");
  const hourEnd = fromZonedTime(`${markDate}T13:00:00`, "America/Chicago");
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
        date: markDate,
        startAt,
        endAt,
        sourcePosition: "Cocina",
        board: "cocina",
      },
    });
  }
  const painted = await prisma.employee.create({
    data: { externalId: "b3s12-painted-moss", firstName: "Gil", lastName: "Moss" },
  });
  const paintedShift = await prisma.shift.create({
    data: {
      employeeId: painted.id,
      date: markDate,
      startAt,
      endAt,
      sourcePosition: "Cocina",
      board: "cocina",
    },
  });
  await prisma.assignment.create({
    data: {
      shiftId: paintedShift.id,
      employeeId: painted.id,
      stationId: "pdf_guia",
      hourStart,
      hourEnd,
    },
  });
  const gridPerson = await prisma.employee.create({
    data: {
      externalId: "b3s12-grid-moss",
      firstName: "Luz",
      lastName: "Moss",
      abilities: { create: [{ stationId: "pdf_guia", level: "training" }] },
    },
  });
  await prisma.shift.create({
    data: {
      employeeId: gridPerson.id,
      date: markDate,
      startAt,
      endAt,
      sourcePosition: "Cocina",
      board: "cocina",
    },
  });
  await prisma.$disconnect();
});

test("K3 owner outlines follow the selected station and Libre stays in the aria-label", async ({ page }) => {
  await keepDesk(page);
  await unlock(page, "8642");
  await openCocina(page);
  const noa = await rowId(page, "Noa Moss");
  const pia = await rowId(page, "Pia Moss");
  const bea = await rowId(page, "Bea Moss");
  const fia = await rowId(page, "Fia Moss");
  const gil = await rowId(page, "Gil Moss");
  const openCells = [noa, pia, bea, fia].map((id) => page.getByTestId(`paint-cell-${id}-12`));
  for (const cell of openCells) {
    await expect(cell).not.toContainText(/Libre|Open/);
    await expect(cell).toHaveAttribute("aria-label", /Libre|Open/);
    await expect(cell).toHaveAttribute("data-outline", "rest");
  }
  await expect(page.getByTestId(`eligibility-dot-${fia}-12-pdf_tq1r`)).toHaveCount(1);

  await page.getByTestId("paint-palette-pdf_tq1r").click();
  await expect(page.getByTestId(`eligibility-dot-${fia}-12-pdf_tq1r`)).toHaveCount(1);
  await expect(page.getByTestId(`paint-cell-${noa}-12`)).toHaveAttribute("data-outline", "none");
  await expect(page.getByTestId(`paint-cell-${pia}-12`)).toHaveAttribute("data-outline", "dashed");
  await expect(page.getByTestId(`paint-cell-${bea}-12`)).toHaveAttribute("data-outline", "solid");
  await expect(page.getByTestId(`paint-cell-${fia}-12`)).toHaveAttribute("data-outline", "filled");
  await expect(page.getByTestId(`paint-cell-${fia}-12`)).toHaveAttribute("data-wash", "1");
  const paintedFill = stationColorClass("light-red");
  const solidFill = stationSolidClass("light-red");
  for (const id of [noa, pia, bea, fia]) {
    const className = await page.getByTestId(`paint-cell-${id}-12`).getAttribute("class");
    expect(className ?? "").not.toContain(paintedFill);
    expect(className ?? "").not.toContain(solidFill);
  }
  await expect(page.getByTestId(`paint-cell-${pia}-12`)).toHaveClass(/border-dashed/);
  await expect(page.getByTestId(`paint-cell-${pia}-12`)).toHaveClass(/border-red-600/);
  await expect(page.getByTestId(`paint-cell-${bea}-12`)).toHaveClass(/border-red-600/);
  await expect(page.getByTestId(`paint-cell-${bea}-12`)).not.toHaveClass(/border-dashed/);
  await expect(page.getByTestId(`paint-cell-${fia}-12`)).toHaveClass(/bg-red-50/);
  const painted = page.getByTestId(`paint-cell-${gil}-12`);
  await expect(painted).not.toHaveAttribute("data-outline", /.+/);
  await expect(painted).toHaveClass(/bg-white/);
  await expect(painted).toHaveClass(/border-neutral-900/);
  const off = page.locator(`[data-testid='paint-row-${noa}'] td[data-kind='off']`).first();
  await expect(off.locator("button")).toHaveCount(0);

  await page.getByTestId("paint-palette-erase").click();
  for (const cell of openCells) await expect(cell).toHaveAttribute("data-outline", "rest");
  await expect(page.getByTestId(`eligibility-dot-${fia}-12-pdf_tq1r`)).toHaveCount(1);
});

test("K4 a manager outline is the same on every open cell and the payload has no abilities", async ({ page }) => {
  const today = await seedTodayPeople("markDate-today");
  const bodies: string[] = [];
  page.on("response", async (response) => {
    if (!response.ok() || !response.url().includes(`/api/boards/cocina/days/${today}`)) return;
    try {
      bodies.push(await response.text());
    } catch {
      /* a later reader took the body */
    }
  });
  await keepDesk(page);
  await unlock(page, "2468");
  await openCocina(page, today);
  await expect(page.locator("[data-testid^='eligibility-dot-']")).toHaveCount(0);
  await page.getByTestId("paint-palette-pdf_tq1r").click();
  const outlined = page.locator("[data-testid^='paint-cell-'][data-outline='manager']");
  await expect(outlined.first()).toBeVisible();
  const classes = await outlined.evaluateAll((nodes) => nodes.map((node) => node.className));
  expect(classes.length).toBeGreaterThan(1);
  expect(new Set(classes).size).toBe(1);
  expect(classes[0] ?? "").not.toContain(stationColorClass("light-red"));
  expect(classes[0] ?? "").not.toContain(stationSolidClass("light-red"));
  expect(classes[0] ?? "").toContain("bg-white");
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  for (const body of bodies) expect(body).not.toContain('"abilities"');

  await unlock(page, "8642");
  await openCocina(page);
  await page.getByTestId("compact-manager").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
  await expect(page.getByTestId("manager-color-editor")).toHaveCount(0);
  await expect(page.locator("[data-testid^='eligibility-dot-']")).toHaveCount(0);
  await expect(page.locator("[data-outline='dashed'], [data-outline='filled']")).toHaveCount(0);
});

test("K5 Habilidades headers keep the station colour, cells use the S12 mark, and the Employees panel keeps entrenando", async ({ page }) => {
  await keepDesk(page);
  await page.goto("/back-office");
  await page.getByTestId("back-office-code").fill("8642");
  await page.getByTestId("back-office-submit").click();
  await page.getByTestId("back-office-tab-habilidades").click();
  await expect(page.getByTestId("abilities-grid")).toBeVisible();
  const header = page.getByTestId("ability-header-pdf_guia");
  const cell = page.getByTestId("ability-cell-b3s12-grid-moss-pdf_guia");
  await expect(cell).toHaveText("poco");
  await expect(header).toHaveClass(/bg-white/);
  await expect(header).toHaveClass(/border-neutral-900/);
  await expect(cell).toHaveAttribute("data-mark", "dashed");
  await expect(cell).toHaveClass(/border-dashed/);
  await expect(cell).toHaveClass(/border-neutral-800/);
  await expect(cell).not.toHaveClass(/border-neutral-900/);
  const marks = await page.locator("[data-testid^='ability-cell-']").evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: (node.textContent ?? "").trim(),
      mark: node.getAttribute("data-mark"),
      className: node.className,
    })),
  );
  const markForWord: Record<string, string> = {
    no: "none",
    poco: "dashed",
    bien: "solid",
    fuerte: "filled",
    mixto: "none",
  };
  expect(marks.length).toBeGreaterThan(0);
  for (const row of marks) {
    expect(row.mark).toBe(markForWord[row.text]);
    if (row.mark === "dashed") expect(row.className).toContain("border-dashed");
    if (row.mark === "none") expect(row.className).toContain("bg-white");
    if (row.mark === "solid") {
      expect(row.className).toContain("border-solid");
      expect(row.className).toContain("bg-white");
    }
    if (row.mark === "filled") {
      expect(row.className).toContain("border-solid");
      expect(row.className).not.toContain("bg-white");
    }
  }
  const words = await page.locator("[data-testid^='ability-cell-']").allTextContents();
  expect(words.some((word) => word.includes("entrenando"))).toBe(false);
  await expect(page.getByTestId("ability-header-pdf_crne")).toHaveCount(0);
  await expect(page.getByTestId("ability-show-hidden")).toContainText(/Mostrar ocultas \([1-9]\d*\)/);
  await page.getByTestId("ability-show-hidden").click();
  await expect(page.getByTestId("ability-header-pdf_crne")).toHaveAttribute("data-hidden", "1");
  await page.getByTestId("ability-hide-pdf_crne").click();
  await expect(page.getByTestId("ability-header-pdf_crne")).toHaveAttribute("data-hidden", "0");
  await page.getByTestId("ability-hide-pdf_crne").click();
  await expect(page.getByTestId("ability-header-pdf_crne")).toHaveAttribute("data-hidden", "1");

  await unlock(page, "8642");
  await expect(page.getByTestId("compact-date").locator(`option[value="${markDate}"]`)).toHaveCount(1);
  await page.getByTestId("compact-date").selectOption(markDate);
  await page.getByTestId("compact-board").selectOption("cocina");
  await page.getByTestId("compact-view").selectOption("board");
  await expect(page.getByTestId("ability-filter").locator("option[value='training']")).toHaveText("entrenando");
});
