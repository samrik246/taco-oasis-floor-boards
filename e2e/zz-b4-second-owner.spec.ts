import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { hashManagerCode } from "../src/lib/managers/codes";
import { chicagoDateTime } from "../src/lib/time";
import { MANDATORY_STATIONS_BY_BOARD } from "../src/lib/mandatory";
import { reviewScenario } from "./fixtures/b4-review";
import { blockedBreakQuarters, offeredBreakSlots } from "../src/lib/breaks/mine";
const root = process.env.FLOOR_BOARDS_TEST_ROOT;
if (!root) throw new Error("Disposable test root required");
const db = new PrismaClient({ datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } } });
const screens = path.join(root, "b4-second-owner-screens");
const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
const at = (s: string) => chicagoDateTime(date, s);
const iso = (s: string) => at(s).toISOString();
async function shot(page: Page, name: string) {
  mkdirSync(screens, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
}
for (const locale of ["es", "en"] as const) {
  test(`${locale}: colored starts, per-duration approval and pending copy`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(value => localStorage.setItem("taco-oasis-locale-v1", value), locale);
    const scenario = reviewScenario(date, true);
    const shifts = scenario.shifts.map((s,i) => ({ id: String(i), board: s.board, startAt: new Date(s.startAt), endAt: new Date(s.endAt) }));
    const otherBreaks = [1,2].map(() => ({ board: "cocina", status: "booked", startAt: at("3:00 pm"), endAt: at("3:30 pm") }));
    const allowed = new Set(offeredBreakSlots({ date, board: "cocina", shifts, otherBreaks }).map(s => `${s.startAt}/${s.endAt}`));
    const data = { name: "Mara Ejemplo", allowanceMinutes: 60, shifts: scenario.shifts, slots: scenario.slots.filter(s => allowed.has(`${s.startAt}/${s.endAt}`)), blocked: blockedBreakQuarters({ date, board: "cocina", shifts, otherBreaks }),
      saved: { board: "cocina", startAt: iso("2:00 pm"), endAt: iso("2:30 pm"), state: "reserved", status: "booked", approval: "gerente" } };
    await page.route("**/api/breaks/session", route => route.fulfill({ json: { kind: "staff", token: "synthetic-example", name: data.name } }));
    await page.route("**/api/breaks/mine", route => route.fulfill({ json: data }));
    await page.route("**/api/breaks/timeline**", route => route.fulfill({ json: { date, asOf: iso("1:45 pm"), gerenteAvailable: true, people: [], breaks: [] } }));
    await page.goto(`/descansos?board=cocina&lang=${locale}`);
    await page.getByTestId("break-code-input").fill("4545"); await page.getByTestId("break-sign-in").click();
    const start = (time: string) => page.locator(`[data-testid="break-start"][data-start="${iso(time)}"]`);
    await expect(start("9:00 am")).toHaveAttribute("data-tone", "automatic");
    await expect(start("2:00 pm")).toHaveAttribute("data-tone", "gerente");
    await expect(start("3:00 pm")).toHaveAttribute("data-tone", "capacity"); await expect(start("3:00 pm")).toBeDisabled();
    // 11:00 is a policy blackout only on weekdays; unavailable colors are also asserted in unit cases.
    if (new Date(`${date}T12:00:00Z`).getUTCDay() % 6 !== 0) await expect(start("11:00 am")).toHaveAttribute("data-tone", "unavailable");
    await expect(start("2:00 pm")).toContainText("60 min");
    await shot(page, `${locale}_04_COLORED_STARTS`);
    await start("2:00 pm").click();
    const short = page.locator(`[data-testid="break-slot"][data-end="${iso("2:15 pm")}"]`);
    await expect(short).toHaveAttribute("data-tone", "automatic");
    await expect(page.locator(`[data-testid="break-slot"][data-end="${iso("3:00 pm")}"]`)).toHaveAttribute("data-tone", "gerente");
    await short.click();
    await expect(short).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("break-save")).toHaveAttribute("data-end", iso("2:15 pm"));
    await shot(page, `${locale}_06_DURATION_APPROVAL`);
    await page.getByTestId("break-close").click();
    data.saved = { ...data.saved, state: "pending", status: "pending" };
    await page.getByTestId("break-code-input").fill("4545"); await page.getByTestId("break-sign-in").click();
    await expect(page.getByTestId("break-status")).toContainText(locale === "es" ? "El horario que pediste puede cambiar. Revisa el tablero BREAK para confirmar la aprobación y el horario antes de salir." : "Your requested time may change. Check the BREAK board for approval and the scheduled time before leaving.");
    await expect(page.getByTestId("break-status")).not.toContainText(/cinco|five-minute|15 minutos|15 minutes/);
    await shot(page, `${locale}_01_PENDING`);
  });

  test(`${locale}: real alternate-time approval reaches both unsigned boards`, async ({ page, context }) => {
    // This file runs last, in one worker. Only its disposable current-date world is replaced.
    await db.staffBreak.deleteMany({ where: { date } });
    await db.boardOverlay.deleteMany({ where: { date } });
    await db.mandatoryMark.deleteMany({ where: { date } });
    // Removed shifts still own unique station/hour rows. Clear this fixture's
    // station windows in the disposable database before installing its crew.
    await db.assignment.deleteMany({ where: { stationId: { in: [...MANDATORY_STATIONS_BY_BOARD.cocina] }, hourStart: { gte: at("8:00 am"), lt: at("4:00 pm") } } });
    await db.shift.updateMany({ where: { date }, data: { boardRemoved: true } });
    const tag = `second-owner-${locale}-${Date.now()}`;
    let asker = "", cover = "";
    const members: { id: string; shiftId: string }[] = [];
    const names = ["Luz", "Nora", "Paz", "Alba", "Mara", "Sol"];
    for (const [i, stationId] of [...MANDATORY_STATIONS_BY_BOARD.cocina, null].entries()) {
      const employee = await db.employee.create({ data: { externalId: `${tag}-${i}`, firstName: names[i], lastName: "Ejemplo" } });
      const shift = await db.shift.create({ data: { employeeId: employee.id, date, board: "cocina", sourcePosition: "Cocina", startAt: at(stationId ? "8:00 am" : "3:00 pm"), endAt: at("4:00 pm") } });
      members.push({ id: employee.id, shiftId: shift.id });
      if (stationId === "pdf_guia") asker = employee.id;
      if (!stationId) cover = employee.id;
      if (stationId) await db.assignment.createMany({ data: Array.from({ length: 8 }, (_, j) => ({ employeeId: employee.id, shiftId: shift.id, stationId, hourStart: new Date(at("8:00 am").getTime()+j*3600000), hourEnd: new Date(at("8:00 am").getTime()+(j+1)*3600000) })) });
    }
    await db.employeeStationAbility.create({ data: { employeeId: cover, stationId: "pdf_guia", level: "ok" } });
    const pending = await db.staffBreak.create({ data: { employeeId: asker, shiftId: members.find(p => p.id === asker)!.shiftId, date, board: "cocina", actor: asker, status: "pending", startAt: at("2:00 pm"), endAt: at("2:30 pm") } });
    const manager = await db.manager.create({ data: { name: "Gerente Ejemplo", role: "owner", active: true, longIdle: true, codeHash: hashManagerCode(`${tag}-credential`) } });
    const paintBefore = await db.assignment.findMany({ where: { shiftId: { in: members.map(p => p.shiftId) } }, orderBy: { id: "asc" } });
    const boardPages = await Promise.all([context.newPage(), context.newPage()]);
    for (const [i, board] of ["caja", "cocina"].entries()) {
      await boardPages[i].addInitScript(value => localStorage.setItem("taco-oasis-locale-v1", value), locale);
      await boardPages[i].clock.setFixedTime(at("9:30 am"));
      await boardPages[i].setViewportSize({ width: 1280, height: 800 });
      await boardPages[i].goto(`/?board=${board}&kiosk=1&lang=${locale}`);
      await expect(boardPages[i].getByTestId("break-strip")).toContainText("Mara");
      await expect(boardPages[i].getByTestId("break-sheet")).toHaveCount(0);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(value => localStorage.setItem("taco-oasis-locale-v1", value), locale);
    await page.goto(`/descansos?board=cocina&lang=${locale}`);
    await page.getByTestId("break-code-input").fill(`${tag}-credential`); await page.getByTestId("break-sign-in").click();
    await page.getByTestId("break-review").click();
    await expect(page.getByTestId("descanso-cover")).toHaveCount(0);
    const alternative = page.locator(`[data-testid="descanso-alternative"][data-start="${iso("3:00 pm")}"]`);
    await expect(alternative).toContainText("Sol"); await expect(alternative).toContainText("30 min");
    await expect(alternative.getByTestId("cover-positions")).toContainText(/Guía|Guide/);
    await expect(page.getByTestId("descanso-clear")).toBeEnabled(); await expect(page.getByTestId("descanso-recheck")).toBeEnabled();
    await shot(page, `${locale}_02_NO_COVER_ALTERNATIVES`);
    const lastAlternative = page.getByTestId("descanso-alternative").last();
    await page.getByTestId("descanso-dialog").locator(":scope > div").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(lastAlternative).toBeInViewport({ ratio: 1 });
    const lastBox = await lastAlternative.boundingBox();
    const actionsBox = await page.getByTestId("descanso-clear").locator("..").boundingBox();
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(actionsBox!.y);
    await shot(page, `${locale}_07_ALTERNATIVES_END`);
    const response = page.waitForResponse(r => r.url().endsWith("/api/breaks/manage") && r.request().method() === "POST");
    await alternative.click(); const result = await response;
    expect(result.status()).toBe(200); expect(await result.json()).toMatchObject({ waiting: false });
    await expect(page.getByTestId("descanso-dialog")).toHaveCount(0);
    const saved = await db.staffBreak.findUniqueOrThrow({ where: { id: pending.id } });
    expect(saved).toMatchObject({ status: "booked", coverEmployeeId: cover, startAt: at("3:00 pm"), endAt: at("3:30 pm") });
    for (const board of boardPages) {
      await board.bringToFront(); await board.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(board.getByTestId("break-strip")).toContainText(/Reservado|Reserved/);
      await expect(board.getByTestId("break-strip")).toContainText(/3:00 PM/);
      await expect(board.getByTestId("break-sheet")).toHaveCount(0);
    }
    await shot(boardPages[1], `${locale}_05_UNSIGNED_BOARD_STRIP`);
    expect(await db.assignment.findMany({ where: { shiftId: { in: members.map(p => p.shiftId) } }, orderBy: { id: "asc" } })).toEqual(paintBefore);
    mkdirSync(screens, { recursive: true });
    writeFileSync(path.join(screens, `${locale}_alternate-time-result.json`), JSON.stringify({ date, pending: { id: pending.id, startAt: pending.startAt, endAt: pending.endAt }, saved: { id: saved.id, startAt: saved.startAt, endAt: saved.endAt, status: saved.status, coverEmployeeId: saved.coverEmployeeId }, response: await result.json(), paintUnchanged: true, unsignedBoards: ["caja", "cocina"] }, null, 2));
    await db.manager.update({ where: { id: manager.id }, data: { active: false } });
    for (const board of boardPages) await board.close();
  });
}
