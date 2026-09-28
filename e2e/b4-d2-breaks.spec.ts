import path from "node:path";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { hashStaffPasscode, newPasscodeSalt } from "../src/lib/breaks/passcode";
import { chicagoDateTime } from "../src/lib/time";

const pepper = "playwright-staff-passcode-pepper-0000";
const code = "4545";
const externalId = "b4d2-e2e-ada";
const root = process.env.FLOOR_BOARDS_TEST_ROOT;
if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
const prisma = new PrismaClient({
  datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
});

test("staff signs in, picks a break, and the painted hour shows the stripe", async ({ page }) => {
  await page.clock.install();
  const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  const existing = await prisma.employee.findUnique({ where: { externalId } });
  if (existing) {
    await prisma.staffBreak.deleteMany({ where: { employeeId: existing.id } });
    await prisma.staffPasscode.deleteMany({ where: { employeeId: existing.id } });
    await prisma.assignment.deleteMany({ where: { employeeId: existing.id } });
    await prisma.shift.deleteMany({ where: { employeeId: existing.id } });
    await prisma.employee.delete({ where: { id: existing.id } });
  }
  await prisma.staffPasscodeAttempt.deleteMany({ where: { board: "cocina" } });
  const person = await prisma.employee.create({
    data: { externalId, firstName: "Ada", lastName: "Break" },
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
  const station = await prisma.station.findFirstOrThrow({ where: { board: "cocina" } });
  await prisma.assignment.create({
    data: {
      shiftId: shift.id,
      employeeId: person.id,
      stationId: station.id,
      hourStart: chicagoDateTime(date, "9:00 am"),
      hourEnd: chicagoDateTime(date, "10:00 am"),
    },
  });
  const salt = newPasscodeSalt();
  const digest = await hashStaffPasscode(code, salt, pepper);
  await prisma.staffPasscode.create({
    data: { employeeId: person.id, hash: digest.toString("hex"), salt: salt.toString("hex") },
  });

  await page.goto(`/descansos?board=cocina`);
  await page.getByTestId("break-personal").click();
  for (const digit of code) await page.getByTestId(`break-key-${digit}`).click();
  await expect(page.getByTestId("break-name")).toHaveText("Ada Break");
  await page.clock.fastForward(60_000);
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "home");

  await page.getByTestId("break-personal").click();
  for (const digit of code) await page.getByTestId(`break-key-${digit}`).click();
  await expect(page.getByTestId("break-name")).toHaveText("Ada Break");
  const start = chicagoDateTime(date, "9:00 am").toISOString();
  await page.locator(`[data-testid="break-start"][data-start="${start}"]`).click();
  await page.locator(`[data-testid="break-slot"][data-start="${start}"]`).first().click();
  await expect(page.getByTestId("break-saved")).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "home");

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
  await page.goto("/");
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
  await page.getByTestId("compact-date").selectOption(date);
  await page.getByTestId("compact-board").selectOption("cocina");
  await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("manager-color-editor")).toBeVisible();
  await expect(page.getByTestId("break-stripe").first()).toBeVisible();
});

test("kiosk=1 traps the back button on descansos", async ({ page }) => {
  await page.goto("/descansos?board=cocina&kiosk=1");
  await expect(page.getByTestId("break-home")).toBeVisible();
  await expect.poll(() => page.evaluate(() => history.state)).toEqual({ kiosk: true });
  const trapped = await page.evaluate(() => {
    return new Promise<{ href: string; kiosk: boolean }>((resolve) => {
      window.addEventListener("popstate", () => {
        window.setTimeout(() => {
          const state = history.state as { kiosk?: boolean } | null;
          resolve({ href: window.location.href, kiosk: state?.kiosk === true });
        }, 0);
      }, { once: true });
      history.back();
    });
  });
  expect(trapped.kiosk).toBe(true);
  expect(trapped.href).toContain("/descansos?");
  expect(trapped.href).toContain("kiosk=1");
  await expect(page.getByTestId("break-personal")).toBeVisible();
});
