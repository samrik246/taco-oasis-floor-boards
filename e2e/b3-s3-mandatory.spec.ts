import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";

const externalId = "b3s3-lea-moss";
const gapDate = "2034-09-12";
const markDate = "2034-09-14";
const nextDate = "2034-09-15";

function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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

async function openCocina(page: Page, date: string) {
  await expect(page.getByTestId("compact-date").locator(`option[value="${date}"]`)).toHaveCount(1);
  await page.getByTestId("compact-date").selectOption(date);
  await page.getByTestId("compact-board").selectOption("cocina");
  await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("manager-color-editor")).toBeVisible();
}

async function clearOwnerMarks() {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
  });
  await prisma.mandatoryMark.deleteMany({
    where: { board: "cocina", date: { in: [markDate, nextDate] } },
  });
  await prisma.$disconnect();
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
  const existing = await prisma.employee.findUnique({ where: { externalId } });
  if (existing) {
    await prisma.assignment.deleteMany({ where: { employeeId: existing.id } });
    await prisma.shift.deleteMany({ where: { employeeId: existing.id } });
    await prisma.employee.delete({ where: { id: existing.id } });
  }
  const person = await prisma.employee.create({
    data: { externalId, firstName: "Lea", lastName: "Moss" },
  });
  for (const date of [gapDate, markDate, nextDate]) {
    await prisma.shift.create({
      data: {
        employeeId: person.id,
        date,
        startAt: fromZonedTime(`${date}T09:00:00`, "America/Chicago"),
        endAt: fromZonedTime(`${date}T17:00:00`, "America/Chicago"),
        sourcePosition: "Cocina",
        board: "cocina",
      },
    });
  }
  await prisma.$disconnect();
});

test("C6 a mandatory gap lights at 12 and a pending paint clears it, and 10 stays dark", async ({ page }) => {
  await keepDesk(page);
  await unlock(page, "2468");
  await openCocina(page, gapDate);
  const shiftId = await page.getByTestId("paint-matrix").locator("[data-testid^='paint-row-']").first().getAttribute("data-testid");
  const id = shiftId?.replace("paint-row-", "");
  expect(id).toBeTruthy();

  await page.getByTestId("paint-matrix").getByRole("button", { name: "12:00 pm", exact: true }).click();
  const taquero = page.getByTestId("paint-palette-pdf_tq1r");
  await expect(taquero).toContainText("Falta");
  await expect(taquero).toHaveAttribute("data-falta", "1");
  const box = page.getByTestId("mandatory-gap-pdf_tq1r-12");
  await expect(box).toHaveText("TQ1R");
  await expect(box).toHaveClass(/pink/);

  await page.getByTestId("paint-matrix").getByRole("button", { name: "10:00 am", exact: true }).click();
  await expect(page.getByTestId("paint-palette-pdf_tq1r")).not.toContainText("Falta");
  await expect(page.getByTestId("paint-palette-pdf_tq1r")).toHaveAttribute("data-falta", "0");
  await expect(page.getByTestId("mandatory-gap-hour-10").locator("[data-testid^='mandatory-gap-']")).toHaveCount(0);

  await page.getByTestId("paint-matrix").getByRole("button", { name: "12:00 pm", exact: true }).click();
  await page.getByTestId("paint-palette-pdf_tq1r").click();
  await page.getByTestId(`paint-cell-${id}-12`).click();
  await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
  await expect(page.getByTestId("paint-palette-pdf_tq1r")).not.toContainText("Falta");
  await expect(page.getByTestId("mandatory-gap-pdf_tq1r-12")).toHaveCount(0);
});

// Chromium ignores `pointer` on Emulation.setEmulatedMedia. Touch emulation is what flips `(pointer: coarse)`.
test.describe("coarse pointer", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async () => {
    await clearOwnerMarks();
  });

  test("C7 an owner mark lights for that date only, and a manager and a staff tablet see no toggle", async ({ page }) => {
    await keepDesk(page);
    await unlock(page, "8642");
    await openCocina(page, markDate);
    expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.getByTestId("paint-matrix").getByRole("button", { name: "12:00 pm", exact: true }).click();
    await expect(page.getByTestId("paint-palette-pdf_tq1r")).toContainText("Falta");
    await expect(page.getByTestId("paint-palette-pdf_pstl")).not.toContainText("Falta");
    await expect(page.getByTestId("mandatory-toggle-pdf_tq1r")).toHaveCount(0);

    await page.getByTestId("mandatory-toggle-pdf_pstl").click();
    await expect(page.getByTestId("mandatory-toggle-pdf_pstl")).toHaveAttribute("aria-pressed", "true");
    const pill = await page.getByTestId("mandatory-toggle-pdf_pstl").boundingBox();
    const card = await page.getByTestId("paint-palette-pdf_pstl").boundingBox();
    expect(pill && card && pill.width < card.width).toBeTruthy();
    const hit = await page.getByTestId("mandatory-toggle-pdf_pstl").evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const face = button.querySelector("[data-mandatory-face]")!.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + 6, rect.top + 4);
      return {
        coarse: window.matchMedia("(pointer: coarse)").matches,
        hitHeight: rect.height,
        hitWidth: rect.width,
        faceHeight: face.height,
        cardWidth: button.parentElement?.getBoundingClientRect().width ?? 0,
        topIsButton: top === button,
      };
    });
    expect(hit.coarse).toBe(true);
    expect(hit.hitHeight).toBeGreaterThanOrEqual(48);
    expect(hit.hitWidth).toBeGreaterThanOrEqual(48);
    expect(hit.hitWidth).toBeLessThan(hit.cardWidth);
    expect(hit.faceHeight).toBeLessThan(hit.hitHeight);
    expect(hit.topIsButton).toBe(true);
    await page.getByTestId("mandatory-toggle-pdf_pstl").click({ position: { x: 6, y: 4 } });
    await expect(page.getByTestId("mandatory-toggle-pdf_pstl")).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("mandatory-toggle-pdf_pstl").click({ position: { x: 6, y: 4 } });
    await expect(page.getByTestId("mandatory-toggle-pdf_pstl")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("paint-palette-pdf_pstl")).toContainText("Falta");
    const extra = page.getByTestId("mandatory-gap-pdf_pstl-12");
    await expect(extra).toHaveText("PSTL");
    await expect(extra).toHaveClass(/purple/);

    await page.getByTestId("compact-date").selectOption(nextDate);
    await page.getByTestId("paint-matrix").getByRole("button", { name: "12:00 pm", exact: true }).click();
    await expect(page.getByTestId("paint-palette-pdf_tq1r")).toContainText("Falta");
    await expect(page.getByTestId("paint-palette-pdf_tf1r")).toContainText("Falta");
    await expect(page.getByTestId("paint-palette-pdf_pr1e")).toContainText("Falta");
    await expect(page.getByTestId("paint-palette-pdf_pstl")).not.toContainText("Falta");
    await expect(page.getByTestId("mandatory-toggle-pdf_pstl")).toHaveAttribute("aria-pressed", "false");

    await unlock(page, "2468");
    await openCocina(page, markDate);
    await expect(page.locator("[data-testid^='mandatory-toggle-']")).toHaveCount(0);
    await page.getByTestId("paint-matrix").getByRole("button", { name: "12:00 pm", exact: true }).click();
    await expect(page.getByTestId("paint-palette-pdf_pstl")).toContainText("Falta");

    await page.goto("/");
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    await expect(page.getByText("Falta")).toHaveCount(0);
    await expect(page.getByText("Obligatorio hoy")).toHaveCount(0);
    await expect(page.getByTestId("mandatory-gaps")).toHaveCount(0);
    await page.goto(`/?wall=1&date=${chicagoToday()}`);
    await expect(page.getByText("Falta")).toHaveCount(0);
    await expect(page.getByTestId("mandatory-gaps")).toHaveCount(0);
  });
});
