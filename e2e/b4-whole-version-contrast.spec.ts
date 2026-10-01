import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { chicagoDateTime } from "../src/lib/time";
import type { DayBoardDto } from "../src/components/board/types";

const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
for (const board of ["caja", "cocina"] as const) for (const locale of ["es", "en"] as const) for (const scheme of ["light", "dark"] as const) {
  test(`${board} ${locale} ${scheme}: occupied names contrast on light and dark tiles`, async ({ page }) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.clock.install({ time: chicagoDateTime(date, "9:30 am") });
    await page.addInitScript(value => localStorage.setItem("taco-oasis-locale-v1", value), locale);
    let writes = 0;
    page.on("request", req => { if (req.url().includes("/api/assignments") && req.method() !== "GET") writes++; });
    let ids: string[] = [];
    await page.route(`**/api/boards/${board}/days/*`, async route => {
      const response = await route.fetch();
      if (!response.ok()) { await route.fulfill({ response }); return; }
      const original: DayBoardDto = await response.json();
      const stations = original.stations.slice(0, 2).map((s, i) => ({ ...s, color: i === 0 ? "light-green" : "brown" }));
      ids = stations.map(s => s.id);
      const startAt = chicagoDateTime(date, "9:00 am").toISOString(), endAt = chicagoDateTime(date, "10:00 am").toISOString();
      const shifts = stations.map((s, i) => ({ id: `contrast-shift-${i}`, date, board, startAt, endAt, sourcePosition: board === "caja" ? "Caja" : "Cocina",
        employee: { id: `contrast-${i}`, firstName: i === 0 ? "Luz" : "Sol", lastName: "Example", email: null },
        assignments: [{ id: `contrast-assignment-${i}`, stationId: s.id, hourStart: startAt, hourEnd: endAt, seatNumber: 1 }] }));
      await route.fulfill({ response, json: { ...original, stations, shifts, auxiliaryShifts: [], overlays: [], breaks: [], returnPrompts: [] } });
    });
    await page.goto(`/?board=${board}`);
    await page.getByTestId("toolbar-more").click();
    await page.getByTestId("view-toggle-board").click();
    await expect(page.getByTestId("station-grid")).toBeVisible();
    const observations = [];
    for (const id of ids) {
      const chip = page.getByTestId(`assignee-${id}`);
      await expect(chip).toBeVisible();
      const observation = await chip.evaluate(element => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const rgb = (value: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
        const luminance = (values: number[]) => values.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const foreground = rgb(getComputedStyle(element).color), background = rgb(getComputedStyle(element.parentElement!).backgroundColor);
        const a = luminance(foreground), b = luminance(background);
        return { name: element.textContent, foreground, background, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
      expect(observation.foreground[3]).toBe(255);
      expect(observation.background[3]).toBe(255);
      expect(observation.contrast).toBeGreaterThanOrEqual(4.5);
      observations.push({ stationId: id, ...observation });
    }
    expect(observations).toHaveLength(2);
    const out = path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "b4-whole-version-screens"); mkdirSync(out, { recursive: true });
    const name = `${board}_${locale}_${scheme}_contrast`;
    await page.screenshot({ path: path.join(out, name + ".png"), fullPage: true });
    writeFileSync(path.join(out, name + ".json"), JSON.stringify({ board, locale, scheme, observations }, null, 2));
    expect(writes).toBe(0);
  });
}
