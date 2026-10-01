import { test, expect } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { projectCoverDisplay, type CoverDisplayShift } from "../src/lib/board/cover-display";
import { chicagoDateTime } from "../src/lib/time";
import type { DayBoardDto } from "../src/components/board/types";
const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
const at = (clock: string) => chicagoDateTime(date, clock);
for (const board of ["caja", "cocina"] as const) for (const locale of ["es", "en"] as const) {
  test(`${board} ${locale}: saved cover, proportional BREAK, floor/wall and draft isolation`, async ({ page }) => {
    await page.setViewportSize({ width: 1365, height: 900 });
    await page.clock.install({ time: at("9:30 am") });
    await page.addInitScript(value => localStorage.setItem("taco-oasis-locale-v1", value), locale);
    await page.route("**/api/managers", async route => { const response = await route.fetch(); const body = await response.json(); await route.fulfill({ response, json: { ...body, idleMs: 120_000 } }); });
    let writes = 0, payload: DayBoardDto;
    page.on("request", r => { if (r.url().includes("/api/assignments") && r.method() !== "GET") writes++; });
    await page.route(`**/api/boards/${board}/days/*`, async route => {
      const response = await route.fetch(); if (!response.ok()) { await route.fulfill({ response }); return; }
      const base: DayBoardDto = await response.json(); const station = base.stations[0];
      const primary: CoverDisplayShift = { id: "primary-shift", employeeId: "primary", date, board, startAt: at("8:00 am"), endAt: at("12:00 pm"), supersededAt: null, boardRemoved: false,
        employee: { firstName: "Dylan", lastName: "Example" }, assignments: [8, 9, 10, 11].map(h => ({ stationId: station.id, hourStart: at(`${h}:00 am`), hourEnd: at(h === 11 ? "12:00 pm" : `${h + 1}:00 am`) })) };
      const cover: CoverDisplayShift = { ...primary, id: "cover-shift", employeeId: "cover", board: "other", employee: { firstName: "Dan", lastName: "Example" }, assignments: [] };
      const booking = { id: "booked", employeeId: primary.employeeId, shiftId: primary.id, date, board, status: "booked", startAt: at("9:15 am"), endAt: at("9:45 am"), coverEmployeeId: cover.employeeId, coverShiftId: cover.id, shuffleEmployeeId: null, shuffleShiftId: null, auto: false };
      payload = { ...base, shifts: [{ id: primary.id, date, board, startAt: primary.startAt.toISOString(), endAt: primary.endAt.toISOString(), sourcePosition: board === "caja" ? "Caja" : "Cocina",
        employee: { id: primary.employeeId, ...primary.employee, email: null }, assignments: primary.assignments.map((a, i) => ({ id: `assignment-${i}`, stationId: a.stationId, hourStart: a.hourStart.toISOString(), hourEnd: a.hourEnd.toISOString() })) }],
        auxiliaryShifts: [{ id: cover.id, date, startAt: cover.startAt.toISOString(), endAt: cover.endAt.toISOString(), sourcePosition: "Office", employee: { id: cover.employeeId, ...cover.employee } }], overlays: [],
        breaks: [{ employeeId: primary.employeeId, shiftId: primary.id, startAt: booking.startAt.toISOString(), endAt: booking.endAt.toISOString(), coverEmployeeId: cover.employeeId }],
        coverDisplay: projectCoverDisplay({ board, date, now: at("9:30 am"), stations: base.stations.map(s => ({ ...s, board })), shifts: [primary, cover], bookings: [booking], overlays: [] }) };
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`/?board=${board}`);
    const schedule = page.getByTestId("schedule-panel");
    await expect(schedule.getByTestId("cover-row-cover-shift")).toContainText("Dan Example");
    const cell = schedule.locator('[data-testid="saved-hour"][data-hour="9"]').first();
    const bar = cell.locator('[data-kind="break"]');
    const cellBox = await cell.boundingBox(), breakBox = await bar.boundingBox();
    expect(breakBox!.width / cellBox!.width).toBeCloseTo(0.5, 2);
    expect((breakBox!.x - cellBox!.x) / cellBox!.width).toBeCloseTo(0.25, 2);
    const coverBox = await schedule.getByTestId("cover-row-cover-shift").locator('[data-hour="9"]').boundingBox();
    expect(Math.abs(coverBox!.x - cellBox!.x)).toBeLessThan(2);
    expect(Math.abs(coverBox!.width - cellBox!.width)).toBeLessThan(2);
    await expect(schedule.getByTestId("schedule-headcount-9")).toHaveText("1");
    await page.clock.fastForward(20_500);
    await expect(page.getByTestId("auxiliary-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(schedule.getByTestId("cover-row-cover-shift")).toBeVisible();
    const screens = path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "b4-cover-display-screens"); mkdirSync(screens, { recursive: true });
    await page.screenshot({ path: path.join(screens, `${board}_${locale}_schedule.png`), fullPage: true });
    await page.getByTestId("compact-manager").click(); await page.getByTestId("manager-code-input").fill("8642"); await page.getByTestId("manager-unlock-submit").click();
    await expect(page.getByTestId("manager-color-editor")).toBeVisible();
    await page.getByTestId("compact-view").selectOption("board");
    const occupants = page.getByTestId(`station-${payload!.stations[0].id}`).getByTestId("saved-station-occupants");
    await expect(occupants).toContainText("Dan Example"); await expect(occupants).toContainText("9:15 AM–9:45 AM");
    await expect(occupants).toContainText("Dylan Example");
    const baseOccupant = occupants.locator('[data-employee="primary"]').first();
    const derivedOccupant = occupants.locator('[data-employee="cover"]');
    await expect(baseOccupant.getByRole("button", { name: "Clear Dylan Example", exact: true })).toBeVisible();
    await expect(derivedOccupant.getByRole("button", { name: /^Clear / })).toHaveCount(0);
    const baseLedger = page.waitForRequest(r => r.url().includes("/api/employees/primary/hours?"));
    await baseOccupant.getByRole("button", { name: "Dylan Example", exact: true }).click(); await baseLedger;
    const coverLedger = page.waitForRequest(r => r.url().includes("/api/employees/cover/hours?"));
    await derivedOccupant.getByRole("button", { name: "Dan Example", exact: true }).click(); await coverLedger;
    await page.screenshot({ path: path.join(screens, `${board}_${locale}_floor.png`), fullPage: true });
    await page.getByTestId("compact-view").selectOption("timeline");
    const editor = page.getByTestId("manager-color-editor"); await expect(editor).toBeVisible();
    const paint = editor.getByTestId("paint-cell-primary-shift-9"); await expect(paint.getByTestId("break-stripe")).toBeVisible();
    await expect(editor.getByTestId("paint-headcount-9")).toHaveText("1");
    await expect(editor.getByTestId("cover-row-cover-shift")).toContainText("Dan Example");
    const savedCover = editor.getByTestId("cover-row-cover-shift").locator('[data-hour="9"]');
    const approvedText = (await savedCover.textContent())!;
    await page.getByTestId(`paint-palette-${payload!.stations[1].id}`).click();
    await paint.click();
    const paintedCell = paint.locator("xpath=..");
    await expect(paintedCell).toHaveAttribute("data-pending", "1");
    await expect(paintedCell).toContainText(locale === "es" ? "Guardado" : "Saved");
    await expect(paintedCell.getByTestId("break-stripe")).toBeVisible();
    await expect(savedCover).toHaveText(approvedText);
    await page.screenshot({ path: path.join(screens, `${board}_${locale}_pintar.png`), fullPage: true });
    await page.goto(`/?wall=1&board=${board}`);
    await expect(page.getByTestId(`wall-who-${payload!.stations[0].id}`)).toContainText("Dan Example");
    await expect(page.getByTestId(`wall-who-${payload!.stations[0].id}`)).toContainText("9:15 AM–9:45 AM");
    const wallOccupants = page.getByTestId(`wall-who-${payload!.stations[0].id}`);
    await expect(wallOccupants).not.toContainText("Dylan Example");
    expect(await wallOccupants.getByTestId("saved-station-name").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(36);
    const wallBreak = page.getByTestId("cover-row-primary-shift").locator('[data-kind="break"]');
    await expect(wallBreak).toBeVisible();
    await page.screenshot({ path: path.join(screens, `${board}_${locale}_wall.png`), fullPage: true });
    for (const [clock, present, absent] of [["9:14 am", "Dylan Example", "Dan Example"], ["9:15 am", "Dan Example", "Dylan Example"], ["9:45 am", "Dylan Example", "Dan Example"]]) {
      await page.clock.setSystemTime(at(clock)); await page.reload();
      await expect(wallOccupants).toContainText(present);
      await expect(wallOccupants).not.toContainText(absent);
    }
    expect(writes).toBe(0);
  });
}

test("Shuffle keeps both destinations and cross-board wall absence/return consistent", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.clock.install({ time: at("9:30 am") });
  let cajaIds: string[] = [], originId = "";
  await page.route("**/api/boards/*/days/*", async route => {
    const response = await route.fetch(); if (!response.ok()) { await route.fulfill({ response }); return; }
    const base: DayBoardDto = await response.json();
    const otherBoard = base.board === "caja" ? "cocina" : "caja";
    const otherResponse = await page.request.get(new URL(`/api/boards/${otherBoard}/days/${date}`, route.request().url()).toString());
    const other: DayBoardDto = await otherResponse.json();
    const caja = base.board === "caja" ? base : other, cocina = base.board === "cocina" ? base : other;
    cajaIds = caja.stations.slice(0, 3).map(s => s.id); originId = cocina.stations[0].id;
    const makeShift = (id: string, board: "caja" | "cocina", stationId: string): CoverDisplayShift => ({
      id: `${id}-shift`, employeeId: id, date, board, sourcePosition: board === "caja" ? "Caja" : "Cocina",
      startAt: at("8:00 am"), endAt: at("12:00 pm"), supersededAt: null, boardRemoved: false,
      employee: { firstName: id, lastName: "Example" }, assignments: [8, 9, 10, 11].map(h => ({ stationId, hourStart: at(`${h}:00 am`), hourEnd: at(h === 11 ? "12:00 pm" : `${h + 1}:00 am`) })),
    });
    const shifts = [makeShift("Dylan", "caja", cajaIds[0]), makeShift("Dan", "caja", cajaIds[1]), makeShift("Robin", "cocina", originId)];
    const booking = { id: "shuffle", employeeId: "Dylan", shiftId: "Dylan-shift", date, board: "caja", status: "booked", startAt: at("9:15 am"), endAt: at("9:45 am"), coverEmployeeId: "Dan", coverShiftId: "Dan-shift", shuffleEmployeeId: "Robin", shuffleShiftId: "Robin-shift", auto: false };
    const input = { board: base.board, date, now: at("9:30 am"), shifts, bookings: [booking],
      stations: [...caja.stations.map(s => ({ ...s, board: "caja" })), ...cocina.stations.map(s => ({ ...s, board: "cocina" }))],
      overlays: [{ board: "caja", kind: "switch", employeeId: "Dylan", partnerEmployeeId: null, stationId: cajaIds[2], fromStationId: cajaIds[0], startAt: at("9:30 am"), endAt: at("10:00 am"), cancelledAt: null }] };
    await route.fulfill({ response, json: { ...base, auxiliaryShifts: [], overlays: [],
      shifts: shifts.filter(s => s.board === base.board).map(s => ({ id: s.id, board: s.board, date, sourcePosition: s.sourcePosition,
        startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), employee: { id: s.employeeId, ...s.employee, email: null },
        assignments: s.assignments.map((a, i) => ({ id: `${s.id}-${i}`, stationId: a.stationId, hourStart: a.hourStart.toISOString(), hourEnd: a.hourEnd.toISOString() })) })),
      breaks: base.board === "caja" ? [{ ...booking, startAt: booking.startAt.toISOString(), endAt: booking.endAt.toISOString() }] : [],
      coverDisplay: projectCoverDisplay(input) } });
  });
  await page.goto("/?board=caja");
  await expect(page.getByTestId("schedule-headcount-9")).toHaveText("2");
  await expect(page.getByTestId("cover-row-Robin-shift")).toContainText("Robin Example");
  await page.goto("/?wall=1&board=caja");
  await expect(page.getByTestId("wall-board")).toHaveAttribute("data-board", "caja");
  await expect(page.getByTestId(`wall-who-${cajaIds[2]}`)).toContainText("Dan Example");
  await expect(page.getByTestId(`wall-who-${cajaIds[2]}`)).not.toContainText("Dylan Example");
  await expect(page.getByTestId(`wall-who-${cajaIds[1]}`)).toContainText("Robin Example");
  await expect(page.getByTestId(`wall-who-${cajaIds[1]}`)).not.toContainText("Dan Example");
  await expect(page.getByTestId(`wall-station-${cajaIds[0]}`)).toHaveCount(0);
  const screens = path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "b4-cover-display-screens"); mkdirSync(screens, { recursive: true });
  await page.screenshot({ path: path.join(screens, "shuffle_caja.png"), fullPage: true });
  await page.goto("/?wall=1&board=cocina");
  await expect(page.getByTestId("cover-row-Robin-shift")).toContainText("Robin Example");
  await expect(page.getByTestId(`wall-station-${originId}`)).toHaveCount(0);
  await page.screenshot({ path: path.join(screens, "shuffle_origin.png"), fullPage: true });
  for (const [clock, count] of [["9:14 am", 1], ["9:15 am", 0], ["9:30 am", 0], ["9:45 am", 1]] as const) {
    await page.clock.setSystemTime(at(clock)); await page.reload();
    await expect(page.getByTestId("cover-row-Robin-shift")).toBeVisible();
    await expect(page.getByTestId(`wall-station-${originId}`)).toHaveCount(count);
    if (count) await expect(page.getByTestId(`wall-who-${originId}`)).toContainText("Robin Example");
  }
});
