import { expect, test, type Page } from "@playwright/test";

const yesterday = "2026-09-26";
const today = "2026-09-27";
const board = (date: string) => ({
  board: "caja",
  date,
  stations: [{
    id: "yellow",
    label: "Old station",
    color: "yellow",
    maxConcurrent: 1,
    sortOrder: 1,
    priority: null,
  }],
  shifts: [],
});
const forecast = {
  board: "caja",
  dow: 6,
  dayMedian: 1,
  thresholdRatio: 1.35,
  threshold: 1.35,
  hours: [],
  rushHours: [10],
  ranges: [{ startHour: 10, endHourExclusive: 11 }],
};

async function openWall(page: Page) {
  await page.goto("/?wall=1&board=caja");
  await expect(page.getByTestId("wall-board")).toBeVisible();
  await expect(page.getByTestId("wall-station-yellow")).toBeVisible();
}

test("mounted wall drops yesterday's grid and forecast through an offline lead window", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-26T14:50:00Z") }); // 09:50 Chicago
  await page.route("**/api/boards/caja/days/**", (route) => {
    if (route.request().url().endsWith(`/${yesterday}`)) {
      return route.fulfill({ json: board(yesterday) });
    }
    return route.abort("failed");
  });
  await page.route("**/api/rush?**", (route) => {
    if (route.request().url().includes(`date=${yesterday}`)) {
      return route.fulfill({ json: { forecast } });
    }
    return route.abort("failed");
  });

  await openWall(page);
  await expect(page.getByTestId("rush-lead-banner")).toContainText("10 min");
  await page.clock.fastForward(51_030_000); // next day 00:00:30 Chicago
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await expect(page.getByTestId("wall-board")).toContainText(`${today} CT`);
  await expect(page.getByTestId("wall-station-yellow")).toHaveCount(0);

  await page.clock.fastForward(35_370_000); // 09:50 Chicago, ten minutes before rush
  await expect(page.getByTestId("wall-board")).toContainText(`${today} CT`);
  await expect(page.getByTestId("rush-lead-banner")).toHaveCount(0);
});

test("same-day forecast still leads during a failed board refresh", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-27T14:50:00Z") }); // 09:50 Chicago
  let boardRequests = 0;
  await page.route("**/api/boards/caja/days/**", (route) => {
    boardRequests += 1;
    return boardRequests === 1
      ? route.fulfill({ json: board(today) })
      : route.abort("failed");
  });
  await page.route("**/api/rush?**", (route) => route.fulfill({ json: { forecast: { ...forecast, dow: 0 } } }));

  await openWall(page);
  await expect(page.getByTestId("rush-lead-banner")).toContainText("10 min");
  await page.clock.fastForward(15_100);
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await expect(page.getByTestId("rush-lead-banner")).toContainText("10 min");
});

test("a late response for yesterday cannot restore its forecast", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-27T04:58:00Z") }); // 23:58 Chicago
  let releaseOldForecast: (() => void) | undefined;
  await page.route("**/api/boards/caja/days/**", (route) =>
    route.request().url().endsWith(`/${yesterday}`)
      ? route.fulfill({ json: board(yesterday) })
      : route.abort("failed"),
  );
  await page.route("**/api/rush?**", async (route) => {
    if (!route.request().url().includes(`date=${yesterday}`)) return route.abort("failed");
    await new Promise<void>((resolve) => { releaseOldForecast = resolve; });
    return route.fulfill({ json: { forecast } });
  });

  await openWall(page);
  await expect.poll(() => Boolean(releaseOldForecast)).toBe(true);
  await page.clock.fastForward(150_000); // 00:00:30 Chicago
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await expect(page.getByTestId("wall-board")).toContainText(`${today} CT`);
  releaseOldForecast?.();
  await page.clock.fastForward(35_370_000); // 09:50 Chicago
  await expect(page.getByTestId("rush-lead-banner")).toHaveCount(0);
  await expect(page.getByTestId("wall-station-yellow")).toHaveCount(0);
});
