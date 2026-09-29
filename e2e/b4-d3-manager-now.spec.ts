import path from "node:path";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { chicagoDateTime } from "../src/lib/time";

const externalId = "CODE9182LEAK";
const root = process.env.FLOOR_BOARDS_TEST_ROOT;
if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
const prisma = new PrismaClient({
  datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
});

async function resetPerson(date: string) {
  const existing = await prisma.employee.findUnique({ where: { externalId } });
  if (!existing) return null;
  await prisma.staffBreak.deleteMany({ where: { employeeId: existing.id } });
  await prisma.assignment.deleteMany({ where: { employeeId: existing.id } });
  await prisma.shift.deleteMany({ where: { employeeId: existing.id } });
  await prisma.employee.delete({ where: { id: existing.id } });
  return date;
}

test("a manager moves a break on Pintar, the stripe moves, and the now page shows it", async ({ page }) => {
  const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  await resetPerson(date);
  const person = await prisma.employee.create({
    data: { externalId, firstName: "Ada", lastName: "Leakname" },
  });
  const shift = await prisma.shift.create({
    data: {
      employeeId: person.id,
      date,
      board: "cocina",
      sourcePosition: "Cocina",
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "4:00 pm"),
    },
  });
  const stations = await prisma.station.findMany({
    where: { board: "cocina" },
    orderBy: { sortOrder: "asc" },
    take: 2,
  });
  const painted = stations[0];
  const other = stations[1];
  if (!painted || !other) throw new Error("cocina needs two stations");
  await prisma.assignment.create({
    data: {
      shiftId: shift.id,
      employeeId: person.id,
      stationId: painted.id,
      hourStart: chicagoDateTime(date, "9:00 am"),
      hourEnd: chicagoDateTime(date, "10:00 am"),
    },
  });

  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
  await page.getByTestId("compact-date").selectOption(date);
  await page.getByTestId("compact-board").selectOption("cocina");
  await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("manager-color-editor")).toBeVisible();

  await page.getByTestId(`paint-palette-${other.id}`).click();
  const pendingCell = page.getByTestId(`paint-cell-${shift.id}-10`);
  await pendingCell.click();
  await expect(pendingCell.locator("xpath=..")).toHaveAttribute("data-pending", "1");

  const start = chicagoDateTime(date, "9:00 am").toISOString();
  const shortEnd = chicagoDateTime(date, "9:15 am").toISOString();
  const fullEnd = chicagoDateTime(date, "10:00 am").toISOString();
  await page.getByTestId(`descanso-${person.id}`).click();
  await expect(page.getByTestId("descanso-dialog")).toBeVisible();
  await expect(page.getByTestId("descanso-name")).toHaveText("Ada Leakname");
  await expect(page.getByTestId("descanso-shift")).toHaveText("Ada. 08:00 a 16:00. Le tocan 60 minutos.");
  await page.locator(`[data-testid="descanso-start"][data-start="${start}"]`).click();
  await page.locator(`[data-testid="descanso-slot"][data-end="${shortEnd}"]`).click();
  await expect(page.getByTestId("descanso-save")).toHaveAttribute("data-end", shortEnd);
  await page.getByTestId("descanso-save").click();
  await expect(page.getByTestId("descanso-dialog")).toHaveCount(0);
  const stripe = page.getByTestId(`paint-cell-${shift.id}-9`).locator("[data-testid='break-stripe']");
  await expect(stripe).toHaveAttribute("data-break", "09:00-09:15");
  await expect(pendingCell.locator("xpath=..")).toHaveAttribute("data-pending", "1");

  await page.getByTestId(`descanso-${person.id}`).click();
  await page.locator(`[data-testid="descanso-start"][data-start="${start}"]`).click();
  await expect(page.getByTestId("descanso-save")).toHaveAttribute("data-end", fullEnd);
  await page.getByTestId("descanso-save").click();
  await expect(page.getByTestId("descanso-dialog")).toHaveCount(0);
  await expect(stripe).toHaveAttribute("data-break", "09:00-10:00");
  await expect(pendingCell.locator("xpath=..")).toHaveAttribute("data-pending", "1");

  await page.goto(`/descansos/ahora?board=cocina&kiosk=1`);
  await expect(page.getByTestId("ahora-now")).toContainText("Ada");
  await expect(page.getByTestId("ahora-now")).toContainText("09:00 a 10:00");
  await expect(page.getByTestId("ahora-updated")).toHaveText("actualizado 09:30");
  await expect(page.getByTestId("ahora")).not.toContainText("Leakname");
  await expect(page.getByTestId("ahora")).not.toContainText(externalId);
  await expect(page.getByTestId("ahora")).not.toContainText(person.id);
  await expect(page.locator("a")).toHaveCount(0);
});

test("a failed refresh keeps the last break list", async ({ page }) => {
  await page.clock.install();
  const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  await resetPerson(date);
  const person = await prisma.employee.create({
    data: { externalId, firstName: "Ada", lastName: "Leakname" },
  });
  const shift = await prisma.shift.create({
    data: {
      employeeId: person.id,
      date,
      board: "cocina",
      sourcePosition: "Cocina",
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "4:00 pm"),
    },
  });
  const asOf = fromZonedTime(`${date}T09:30:00`, "America/Chicago");
  await prisma.staffBreak.create({
    data: {
      employeeId: person.id,
      shiftId: shift.id,
      board: "cocina",
      date,
      startAt: new Date(asOf.getTime() - 5 * 60_000),
      endAt: new Date(asOf.getTime() + 20 * 60_000),
      actor: person.id,
    },
  });

  await page.goto("/descansos/ahora?board=cocina");
  await page.clock.fastForward(1);
  await expect(page.getByTestId("ahora-now")).toContainText("Ada");
  await page.route("**/api/breaks/now**", (route) => route.abort());
  await page.clock.fastForward(30_000);
  await expect(page.getByTestId("ahora-error")).toHaveText("No se pudo actualizar");
  await expect(page.getByTestId("ahora-now")).toContainText("Ada");
  await expect(page.getByTestId("ahora")).not.toContainText("Leakname");
});
