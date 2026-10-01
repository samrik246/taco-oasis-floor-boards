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
    await page.screenshot({ path: path.join(screens, `${board}_${locale}_floor.png`), fullPage: true });
    await page.getByTestId("compact-view").selectOption("timeline");
    const editor = page.getByTestId("manager-color-editor"); await expect(editor).toBeVisible();
    const paint = editor.getByTestId("paint-cell-primary-shift-9"); await expect(paint.getByTestId("break-stripe")).toBeVisible();
    await expect(editor.getByTestId("paint-headcount-9")).toHaveText("1");
    await expect(editor.getByTestId("cover-row-cover-shift")).toContainText("Dan Example");
    await page.screenshot({ path: path.join(screens, `${board}_${locale}_pintar.png`), fullPage: true });
    await page.goto(`/?wall=1&board=${board}`);
    await expect(page.getByTestId(`wall-who-${payload!.stations[0].id}`)).toContainText("Dan Example");
    await expect(page.getByTestId(`wall-who-${payload!.stations[0].id}`)).toContainText("9:15 AM–9:45 AM");
    await page.screenshot({ path: path.join(screens, `${board}_${locale}_wall.png`), fullPage: true });
    expect(writes).toBe(0);
  });
}
