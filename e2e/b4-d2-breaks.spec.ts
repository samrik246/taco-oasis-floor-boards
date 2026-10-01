import path from "node:path";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { hashStaffPasscode, newPasscodeSalt } from "../src/lib/breaks/passcode";
import { calendarWeekday } from "../src/lib/breaks/rules";
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
  await expect(page.getByTestId("break-keypad")).toBeVisible();
  await page.getByTestId("break-back").click();
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");
  await page.clock.fastForward(30_000);
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");

  for (const digit of code) await page.getByTestId(`break-key-${digit}`).click();
  await page.getByTestId("break-sign-in").click();
  await expect(page.getByTestId("break-name")).toHaveText("Ada Break");
  await page.clock.fastForward(60_000);
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");

  for (const digit of code) await page.getByTestId(`break-key-${digit}`).click();
  await page.getByTestId("break-sign-in").click();
  await expect(page.getByTestId("break-name")).toHaveText("Ada Break");
  await expect(page.getByTestId("break-shift")).toHaveText("Cocina: 8:00 AM – 4:00 PM. Te tocan máximo 60 minutos");
  const blocked = chicagoDateTime(date, "11:00 am").toISOString();
  const blockedFace = page.locator(`[data-testid="break-start"][data-start="${blocked}"]`);
  const weekday = calendarWeekday(date);
  if (weekday >= 1 && weekday <= 5) {
    await expect(blockedFace).toBeDisabled();
    await expect(blockedFace).toHaveAttribute("data-reason", "Bloqueado");
  } else {
    await expect(blockedFace).toBeEnabled();
    await expect(blockedFace).toHaveAttribute("data-reason", "");
  }
  const start = chicagoDateTime(date, "9:00 am").toISOString();
  const fullEnd = chicagoDateTime(date, "10:00 am").toISOString();
  await page.locator(`[data-testid="break-start"][data-start="${start}"]`).click();
  const save = page.getByTestId("break-save");
  await expect(save).toHaveAttribute("data-end", fullEnd);
  await expect(save).toContainText("9:00 AM – 10:00 AM, 60 min");
  await page.locator(`[data-testid="break-slot"][data-start="${start}"]`).first().click();
  await expect(page.getByTestId("break-saved")).toHaveCount(0);
  await expect(save).not.toHaveAttribute("data-end", fullEnd);
  const shortenedEnd = await save.getAttribute("data-end");
  expect(shortenedEnd).not.toBeNull();
  await save.click();
  // The real clock can place this interval in the future, present or past.
  // Verify the successful save and exact interval rather than a nighttime label.
  await expect(page.getByTestId("break-saved")).toBeVisible();
  expect(await prisma.staffBreak.findFirst({ where: { employeeId: person.id, date } })).toMatchObject({
    status: "booked", startAt: new Date(start), endAt: new Date(shortenedEnd!),
  });
  await page.getByTestId("break-saved-clear").click();
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");
  for (const digit of code) await page.getByTestId(`break-key-${digit}`).click();
  await page.getByTestId("break-sign-in").click();
  await expect(page.getByTestId("break-name")).toHaveText("Ada Break");
  await page.locator(`[data-testid="break-start"][data-start="${start}"]`).click();
  await expect(page.getByTestId("break-save")).toHaveAttribute("data-end", fullEnd);
  await page.getByTestId("break-save").click();
  await expect(page.getByTestId("break-saved")).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");

  await page.route("**/api/breaks/mine", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Se acabó el tiempo. Entra otra vez." }),
    });
  });
  for (const digit of code) await page.getByTestId(`break-key-${digit}`).click();
  await page.getByTestId("break-sign-in").click();
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");
  await page.getByTestId("break-back").click();
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");
  for (const digit of code) await page.getByTestId(`break-key-${digit}`).click();
  await page.getByTestId("break-sign-in").click();
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");
  await page.clock.fastForward(30_000);
  await expect(page.getByTestId("break-home")).toHaveAttribute("data-phase", "keypad");
  await page.unroute("**/api/breaks/mine");

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
  await expect.poll(() => page.evaluate(() => (history.state as { kiosk?: boolean } | null)?.kiosk === true)).toBe(true);
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
  await expect(page.getByTestId("break-keypad")).toBeVisible();
});

test("staff kiosk Descansos returns to that board", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.clock.install();
  const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  const kioskId = "b4d2-e2e-kiosk";
  const kioskCode = "4546";
  const existing = await prisma.employee.findUnique({ where: { externalId: kioskId } });
  if (existing) {
    await prisma.staffBreak.deleteMany({ where: { employeeId: existing.id } });
    await prisma.staffPasscode.deleteMany({ where: { employeeId: existing.id } });
    await prisma.assignment.deleteMany({ where: { employeeId: existing.id } });
    await prisma.shift.deleteMany({ where: { employeeId: existing.id } });
    await prisma.employee.delete({ where: { id: existing.id } });
  }
  const person = await prisma.employee.create({
    data: { externalId: kioskId, firstName: "Nia", lastName: "Kiosk" },
  });
  await prisma.shift.create({
    data: {
      employeeId: person.id,
      date,
      board: "cocina",
      sourcePosition: "Cocina",
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "4:00 pm"),
    },
  });
  const salt = newPasscodeSalt();
  const digest = await hashStaffPasscode(kioskCode, salt, pepper);
  await prisma.staffPasscode.create({
    data: { employeeId: person.id, hash: digest.toString("hex"), salt: salt.toString("hex") },
  });

  const boardBack = /\/\?board=cocina&kiosk=1$/;
  function onBoardKiosk(): boolean {
    const url = new URL(page.url());
    return url.pathname === "/" && url.searchParams.get("board") === "cocina" && url.searchParams.get("kiosk") === "1";
  }
  async function expectQuietBoard() {
    await expect(page).toHaveURL(boardBack);
    await expect(page.getByTestId("break-sheet")).toHaveCount(0);
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    expect(dialogs).toEqual([]);
  }
  async function openFromBoard() {
    if (!onBoardKiosk()) await page.goto("/?board=cocina&kiosk=1");
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    const link = page.getByTestId("open-descansos");
    await expect(link).toHaveText("BREAK");
    await link.click();
    await expect(page.getByTestId("break-sheet")).toBeVisible();
    await expect(page.getByTestId("break-keypad")).toBeVisible();
    await expect(page).toHaveURL(boardBack);
    expect(dialogs).toEqual([]);
  }
  async function signIn() {
      for (const digit of kioskCode) await page.getByTestId(`break-key-${digit}`).click();
      await page.getByTestId("break-sign-in").click();
    await expect(page.getByTestId("break-name")).toHaveText("Nia Kiosk");
  }

  await openFromBoard();
  await signIn();
  await page.clock.fastForward(60_000);
  await expectQuietBoard();

  await openFromBoard();
  await signIn();
  // The earlier case in this file leaves Ada on cocina from 9:00 to 10:00.
  const start = chicagoDateTime(date, "8:00 am").toISOString();
  const fullEnd = chicagoDateTime(date, "9:00 am").toISOString();
  await page.locator(`[data-testid="break-start"][data-start="${start}"]`).click();
  await expect(page.getByTestId("break-save")).toHaveAttribute("data-end", fullEnd);
  await page.getByTestId("break-save").click();
  await expect(page.getByTestId("break-saved")).toBeVisible();
  expect(await prisma.staffBreak.findFirst({ where: { employeeId: person.id, date } })).toMatchObject({
    status: "booked", startAt: new Date(start), endAt: new Date(fullEnd),
  });
  await page.getByTestId("break-saved-clear").click();
  await expectQuietBoard();

  await openFromBoard();
  await signIn();
  await page.locator(`[data-testid="break-start"][data-start="${start}"]`).click();
  await page.getByTestId("break-save").click();
  await expect(page.getByTestId("break-saved")).toBeVisible();
  await page.clock.fastForward(10_000);
  await expectQuietBoard();

  await openFromBoard();
  await signIn();
  await page.getByTestId("break-clear").click();
  await expectQuietBoard();
  await expect(page.getByTestId("open-descansos")).toBeVisible();
  expect(dialogs).toEqual([]);
});
