import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";

const paintDate = "2035-11-04";
const niaId = "b3s4-nia-moss";
const adaId = "b3s4-ada-moss";

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

async function unlock(page: Page) {
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("8642");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
}

test.beforeAll(async () => {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
  });
  for (const externalId of [niaId, adaId]) {
    const existing = await prisma.employee.findUnique({ where: { externalId } });
    if (!existing) continue;
    await prisma.assignment.deleteMany({ where: { employeeId: existing.id } });
    await prisma.shift.deleteMany({ where: { employeeId: existing.id } });
    await prisma.employee.delete({ where: { id: existing.id } });
  }
  const nia = await prisma.employee.create({ data: { externalId: niaId, firstName: "Nia", lastName: "Moss" } });
  const ada = await prisma.employee.create({ data: { externalId: adaId, firstName: "Ada", lastName: "Moss" } });
  const niaShift = await prisma.shift.create({
    data: {
      employeeId: nia.id,
      date: paintDate,
      startAt: fromZonedTime(`${paintDate}T09:00:00`, "America/Chicago"),
      endAt: fromZonedTime(`${paintDate}T17:00:00`, "America/Chicago"),
      sourcePosition: "Cocina",
      board: "cocina",
    },
  });
  const adaShift = await prisma.shift.create({
    data: {
      employeeId: ada.id,
      date: paintDate,
      startAt: fromZonedTime(`${paintDate}T11:00:00`, "America/Chicago"),
      endAt: fromZonedTime(`${paintDate}T17:00:00`, "America/Chicago"),
      sourcePosition: "Cocina",
      board: "cocina",
    },
  });
  await prisma.assignment.create({
    data: {
      shiftId: adaShift.id,
      employeeId: ada.id,
      stationId: "pdf_br1a",
      hourStart: fromZonedTime(`${paintDate}T12:00:00`, "America/Chicago"),
      hourEnd: fromZonedTime(`${paintDate}T13:00:00`, "America/Chicago"),
    },
  });
  await prisma.$disconnect();
  void niaShift;
});

test("D7 Pintar sorts, refuses a taken seat, and shows paint-order numbers", async ({ page }) => {
  await keepDesk(page);
  await unlock(page);
  await page.getByTestId("compact-date").selectOption(paintDate);
  await page.getByTestId("compact-board").selectOption("cocina");
  await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("paint-matrix")).toHaveAttribute("data-sort", "time");
  await page.getByTestId("paint-matrix").getByRole("button", { name: "12:00 pm", exact: true }).click();

  const rowNames = async () => {
    const headers = page.getByTestId("paint-matrix").getByRole("rowheader");
    return (await headers.allTextContents()).map((text) => text.trim()).filter((text) => text.length > 0);
  };
  await expect(page.getByRole("rowheader", { name: /Nia Moss/ })).toBeVisible();
  const entrada = await rowNames();
  expect(entrada[0]).toContain("Nia");
  expect(entrada[1]).toContain("Ada");

  await expect(page.getByTestId("paint-sort-name")).toHaveCount(0);
  await page.getByTestId("paint-sort-position").click();
  const byStation = await rowNames();
  expect(byStation[0]).toContain("Ada");
  expect(byStation.at(-1)).toContain("Nia");
  const pintarPeople = byStation
    .filter((name) => /Nia Moss|Ada Moss/.test(name))
    .map((name) => (name.includes("Ada") ? "Ada" : "Nia"));
  await page.getByTestId("compact-view").selectOption("schedule");
  await page.getByTestId("schedule-sort-position").click();
  const horarioPeople = (await page.locator("[data-testid^='schedule-row-']").allTextContents())
    .map((text) => text.trim())
    .filter((text) => /Nia Moss|Ada Moss/.test(text))
    .map((text) => (text.includes("Ada") ? "Ada" : "Nia"));
  expect(pintarPeople).toEqual(horarioPeople);
  await page.getByTestId("compact-view").selectOption("timeline");

  const niaCell = await page.getByRole("button", { name: /Nia Moss, 12:00 pm/ }).getAttribute("data-testid");
  const adaCell = await page.getByRole("button", { name: /Ada Moss, 12:00 pm/ }).getAttribute("data-testid");
  const niaShift = niaCell?.replace("paint-cell-", "").replace(/-12$/, "");
  const adaShift = adaCell?.replace("paint-cell-", "").replace(/-12$/, "");
  expect(niaShift && adaShift).toBeTruthy();

  await page.getByTestId("paint-palette-pdf_tq2r").click();
  await page.getByTestId(`paint-cell-${niaShift}-12`).click();
  await page.getByTestId("paint-save").click();
  await expect(page.getByTestId("paint-pending")).toContainText(/0/);
  await expect(page.getByTestId(`paint-cell-${niaShift}-12`)).toContainText("Taquero 2");
  await expect(page.getByTestId(`paint-seat-${niaShift}-12`)).toHaveCount(0);

  await page.getByTestId("paint-palette-pdf_tq2r").click();
  await page.getByTestId(`paint-cell-${adaShift}-12`).click();
  await expect(page.getByTestId("paint-feedback")).toContainText(/ocupado|already taken/i);
  await expect(page.getByTestId("paint-pending")).toContainText(/0 cambios pendientes|0 pending changes/);

  await page.getByTestId("paint-palette-pdf_tq1r").click();
  await page.getByTestId(`paint-cell-${adaShift}-12`).click();
  await page.getByTestId("paint-save").click();
  await expect(page.getByTestId(`paint-cell-${adaShift}-12`)).toContainText("Taquero 1");
  await expect(page.getByTestId(`paint-seat-${adaShift}-12`)).toHaveCount(0);
  await expect(page.getByTestId(`paint-seat-${niaShift}-12`)).toHaveCount(0);

  await page.getByTestId("compact-view").selectOption("schedule");
  await expect(page.getByTestId("schedule-block-pdf_tq2r-12")).toContainText("Taquero 2");
  await expect(page.getByTestId("schedule-block-pdf_tq1r-12")).toContainText("Taquero 1");
  await expect(page.getByTestId("schedule-seat-pdf_tq2r-12")).toHaveCount(0);
  await expect(page.getByTestId("schedule-seat-pdf_tq1r-12")).toHaveCount(0);
  await page.getByTestId("schedule-sort-position").click();
  await expect(page.getByTestId("schedule-seat-pdf_tq2r-12")).toHaveCount(0);
  await expect(page.getByTestId("schedule-seat-pdf_tq1r-12")).toHaveCount(0);
});
