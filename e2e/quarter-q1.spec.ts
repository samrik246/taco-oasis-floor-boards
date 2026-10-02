import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { safeDatabasePath } from "../scripts/test-db-path.cjs";
import type { PublicDayV2 } from "../src/lib/quarter/client/day";

const date = "2041-10-12", origin = "http://floor-boards.test:3100";
const ids = ["caja", "cocina"].flatMap(board => [`q1-${board}-full`, `q1-${board}-tail`]);
let db: PrismaClient, active = false;
const requests: string[] = [];
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT!, url = `file:${join(root, "e2e.db")}`;
  safeDatabasePath({ ...process.env, DATABASE_URL: url }); db = new PrismaClient({ datasources: { db: { url } } });
  const state = await db.$queryRawUnsafe<{ phase: string }[]>("SELECT phase FROM QuarterSchema WHERE id=1"); expect(state[0].phase).toBe("prepared");
  for (const board of ["caja", "cocina"]) {
    for (const [suffix, color] of [["a", "blue"], ["b", "purple"]]) await db.station.create({ data: { id: `q1-${board}-${suffix}`, board, label: `Q1 ${suffix.toUpperCase()}`, color, maxConcurrent: 1, sortOrder: 990 + (suffix === "a" ? 0 : 1) } });
    for (const kind of ["full", "tail"]) {
      const id = `q1-${board}-${kind}`;
      await db.employee.create({ data: { id, externalId: id, firstName: kind === "full" ? "Q1 Full" : "Q1 Partial", lastName: "Synthetic" } });
      await db.shift.create({ data: { id, employeeId: id, board, date, sourcePosition: board === "caja" ? "Caja" : "Cocina", startAt: fromZonedTime(`${date}T11:00:00`, "America/Chicago"), endAt: fromZonedTime(`${date}T${kind === "full" ? "14:00" : "12:20"}:00`, "America/Chicago") } });
    }
  }
  await db.$executeRawUnsafe("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=1 WHERE id=1"); active = true;
});
test.afterAll(async () => {
  if (active) {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("DELETE FROM PaintSegment WHERE paintHourId IN (SELECT id FROM PaintHour WHERE date=?)", date);
      await tx.$executeRawUnsafe("DELETE FROM PaintMutation WHERE date=?", date);
      await tx.$executeRawUnsafe("DELETE FROM PaintHour WHERE date=?", date);
      for (const id of requests) await tx.$executeRawUnsafe("DELETE FROM PaintCommandReceipt WHERE requestId=?", id);
      const rows = await tx.$queryRawUnsafe<{ n: number }[]>("SELECT COUNT(*) n FROM PaintHour"); expect(Number(rows[0].n)).toBe(0);
      await tx.$executeRawUnsafe("UPDATE QuarterSchema SET phase='prepared',minReader=1,minWriter=1,activatedAtMs=NULL WHERE id=1");
    });
  }
  await db.shift.deleteMany({ where: { id: { in: ids } } }); await db.employee.deleteMany({ where: { id: { in: ids } } });
  await db.station.deleteMany({ where: { id: { in: ["caja", "cocina"].flatMap(b => [`q1-${b}-a`, `q1-${b}-b`]) } } });
  await db.$disconnect();
});
async function open(page: Page, board: string) {
  await page.goto(`${origin}/?board=${board}`);
  await page.getByTestId("compact-manager").click(); await page.getByTestId("manager-code-input").fill("e2e-second-owner"); await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
  await page.getByTestId("compact-date").selectOption(date); await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("q1-grid")).toBeVisible();
}
async function save(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith("/api/v2/assignments/paint") && r.request().method() === "PUT");
  await page.getByTestId("quarter-save").click(); const result = await response;
  requests.push(result.request().postDataJSON().requestId); expect(await result.json()).toMatchObject({ ok: true });
  expect(result.status()).toBe(200); await expect(page.getByTestId("quarter-private-preview")).toHaveCount(0);
}
async function day(page: Page, board: string): Promise<PublicDayV2> {
  return page.evaluate(async ({ date, board }) => {
    const login = await fetch("/api/managers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "e2e-second-owner" }) });
    const session = await login.json();
    const response = await fetch(`/api/v2/boards/${board}/days/${date}`, { headers: { "x-manager-session": session.sessionToken } });
    if (!response.ok) throw new Error("SYNTHETIC_DAY_UNAVAILABLE"); return response.json();
  }, { date, board });
}

for (const board of ["caja", "cocina"]) test(`Q1 ${board}: real quarter paint, exact erase, mixed-hour entry, drag and grid geometry`, async ({ page }) => {
  test.setTimeout(300_000); await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem("taco-oasis-locale-v1", "en"));
  await open(page, board); expect(await page.evaluate(() => isSecureContext)).toBe(false);
  const full = `q1-${board}-full`, tail = `q1-${board}-tail`, station = `q1-${board}-a`;
  await page.getByTestId("q1-hour-header-11").getByRole("button").click();
  const overview = await page.getByTestId(`q1-hour-cell-${full}-11`).boundingBox();
  const height = await page.getByTestId(`q1-row-${full}`).evaluate(e => e.getBoundingClientRect().height);
  await expect(page.getByTestId("q1-zoom")).toHaveText(">#<");
  await page.getByTestId("q1-zoom").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("q1-zoom")).toHaveText("<#>");
  const expanded = await page.getByTestId(`q1-hour-cell-${full}-11`).boundingBox();
  expect(expanded!.width / overview!.width).toBeCloseTo(4, 2);
  expect(await page.getByTestId(`q1-row-${full}`).evaluate(e => e.getBoundingClientRect().height)).toBe(height);
  const scroll = await page.getByTestId("q1-grid-scroll").boundingBox();
  expect(Math.abs(expanded!.x + expanded!.width / 2 - (scroll!.x + (scroll!.width + 176) / 2))).toBeLessThan(3);
  for (const [minute, count] of [[0, 2], [15, 2], [30, 1], [45, 1]]) await expect(page.getByTestId(`q1-count-12-${minute}`).locator("strong")).toHaveText(String(count));
  await page.getByTestId(`quarter-palette-${station}`).click();
  await page.getByTestId(`quarter-cell-${full}-11-15`).click(); await save(page);
  const first = await day(page, board), hour = first.hours.find(h => h.shiftId === full && h.hourStart === fromZonedTime(`${date}T11:00:00`, "America/Chicago").toISOString())!;
  expect(hour.intervals.filter(i => i.state === "assigned").map(i => [i.startAt, i.endAt, i.stationId])).toEqual([[fromZonedTime(`${date}T11:15:00`, "America/Chicago").toISOString(), fromZonedTime(`${date}T11:30:00`, "America/Chicago").toISOString(), station]]);
  await page.getByTestId("q1-zoom").click();
  await page.getByTestId(`quarter-cell-${full}-11`).click();
  await expect(page.getByTestId("q1-cell-notice")).toContainText("Mixed hour");
  expect(await page.getByTestId("quarter-private-preview").count()).toBe(0);
  await page.getByTestId("q1-cell-notice").getByRole("button", { name: "Edit quarters" }).click();
  await expect(page.getByTestId("q1-grid-scroll")).toHaveAttribute("data-zoom", "quarter");
  // Five factual minutes occupy exactly one third of the last quarter; detail remains readable on tap.
  await page.getByTestId(`quarter-cell-${tail}-12-15`).click(); await save(page);
  const part = page.getByTestId(`quarter-cell-${tail}-12-15`).locator('[data-kind="work"]').first();
  const partBox = await part.boundingBox(), slotBox = await page.getByTestId(`quarter-cell-${tail}-12-15`).boundingBox();
  expect(partBox!.width / slotBox!.width).toBeCloseTo(1 / 3, 2);
  await page.getByTestId(`quarter-cell-${tail}-12-15`).focus(); await expect(page.getByTestId("q1-interval-detail")).toContainText("12:20");
  await expect(page.getByTestId(`quarter-cell-${tail}-12-30`)).toBeDisabled();
  // A mouse drag retains both selected quarters atomically; guides never capture the pointer.
  await page.getByTestId(`quarter-cell-${full}-11-30`).scrollIntoViewIfNeeded();
  const a = await page.getByTestId(`quarter-cell-${full}-11-30`).boundingBox(), b = await page.getByTestId(`quarter-cell-${full}-11-45`).boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + 20); await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + 20, { steps: 10 }); await page.mouse.up();
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(2); await save(page);
  await page.getByRole("button", { name: "Erase", exact: true }).click(); await page.getByTestId(`quarter-cell-${full}-11-15`).click(); await save(page);
  const erased = (await day(page, board)).hours.find(h => h.shiftId === full && h.hourStart === hour.hourStart)!;
  expect(erased.intervals.filter(i => i.state === "assigned").every(i => i.startAt >= fromZonedTime(`${date}T11:30:00`, "America/Chicago").toISOString())).toBe(true);
  const root = process.env.FLOOR_BOARDS_TEST_ROOT!, shots = join(root, "q1-grid-screens"); mkdirSync(shots, { recursive: true });
  const observations = [];
  for (const locale of ["en", "es"]) for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(locale => { localStorage.setItem("taco-oasis-locale-v1", locale); window.dispatchEvent(new Event("taco-locale")); }, locale);
    for (const view of ["quarter", "hour"]) {
      if (await page.getByTestId("q1-grid-scroll").getAttribute("data-zoom") !== view) await page.getByTestId("q1-zoom").click();
      await page.getByTestId("q1-hour-header-11").getByRole("button").click();
      await page.getByTestId("q1-grid-scroll").screenshot({ path: join(shots, `${board}-${locale}-${theme}-${view}.png`) });
      const alignment = await page.getByTestId("q1-hour-header-11").boundingBox(), cell = await page.getByTestId(`q1-hour-cell-${full}-11`).boundingBox();
      expect(alignment!.x).toBeCloseTo(cell!.x, 1); expect(alignment!.width).toBeCloseTo(cell!.width, 1);
      observations.push({ locale, theme, view, header: alignment, cell, rowHeight: await page.getByTestId(`q1-row-${full}`).evaluate(e => e.getBoundingClientRect().height) });
    }
  }
  writeFileSync(join(shots, `${board}-geometry.json`), JSON.stringify({ overview, expanded, height, observations }, null, 2));
});
