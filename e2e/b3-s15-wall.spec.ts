import { test, expect, type Page } from "@playwright/test";
import { fromZonedTime } from "date-fns-tz";

const date = "2026-09-28";

function at(clock: string): Date {
  return fromZonedTime(`${date}T${clock}`, "America/Chicago");
}

function hourStart(hour: number): string {
  return fromZonedTime(`${date}T${String(hour).padStart(2, "0")}:00:00`, "America/Chicago").toISOString();
}

function station(id: string, label: string, sortOrder: number) {
  return { id, label, color: "yellow", maxConcurrent: 1, sortOrder, priority: null, shortCode: id.slice(0, 3).toUpperCase() };
}

function shift(id: string, name: string, stationId: string, hour: number) {
  const start = hourStart(hour);
  return {
    id,
    employee: { id: `${id}-person`, firstName: name, lastName: "Lane" },
    assignments: [{
      id: `${id}-cell`,
      stationId,
      hourStart: start,
      hourEnd: hourStart(hour + 1),
    }],
  };
}

async function openWall(page: Page, body: unknown) {
  await page.route("**/api/boards/caja/days/**", (route) => route.fulfill({ json: body }));
  await page.route("**/api/rush?**", (route) => route.fulfill({ json: { forecast: null } }));
  await page.goto("/?wall=1&board=caja");
  await expect(page.getByTestId("wall-board")).toBeVisible();
}

test("an empty station is absent and a staffed one stays, in board order", async ({ page }) => {
  await page.clock.install({ time: at("12:00:00") });
  await openWall(page, {
    board: "caja",
    date,
    stations: [station("yellow", "Yellow 1", 1), station("green1", "Green 1", 2), station("blue", "Blue", 3)],
    shifts: [shift("ana", "Ana", "yellow", 12), shift("luis", "Luis", "blue", 12)],
  });
  await expect(page.getByTestId("wall-hour")).toContainText("12:00 pm");
  await expect(page.getByTestId("wall-station-yellow")).toContainText("Ana Lane");
  await expect(page.getByTestId("wall-station-blue")).toContainText("Luis Lane");
  await expect(page.getByTestId("wall-station-green1")).toHaveCount(0);
  const ids = await page.getByTestId("wall-stations").locator("section").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-testid")),
  );
  expect(ids).toEqual(["wall-station-yellow", "wall-station-blue"]);
});

test("10:59 shows hour 10 and 11:00 shows hour 11", async ({ page }) => {
  await page.clock.install({ time: at("10:59:00") });
  await openWall(page, {
    board: "caja",
    date,
    stations: [station("yellow", "Yellow 1", 1), station("green1", "Green 1", 2)],
    shifts: [shift("ana", "Ana", "yellow", 10), shift("luis", "Luis", "green1", 11)],
  });
  await expect(page.getByTestId("wall-hour")).toContainText("10:00 am");
  await expect(page.getByTestId("wall-station-yellow")).toBeVisible();
  await expect(page.getByTestId("wall-station-green1")).toHaveCount(0);

  await page.clock.fastForward(60_000);
  await expect(page.getByTestId("wall-hour")).toContainText("11:00 am");
  await expect(page.getByTestId("wall-station-green1")).toBeVisible();
  await expect(page.getByTestId("wall-station-yellow")).toHaveCount(0);
});

test("before 7:00 and from 22:00 the wall draws no station tiles", async ({ page }) => {
  const body = {
    board: "caja",
    date,
    stations: [station("yellow", "Yellow 1", 1)],
    shifts: [shift("ana", "Ana", "yellow", 12)],
  };
  await page.clock.install({ time: at("06:30:00") });
  await openWall(page, body);
  await expect(page.getByTestId("wall-hour")).toContainText("Outside service hours");
  await expect(page.getByTestId("wall-clock")).toBeVisible();
  await expect(page.getByTestId("wall-station-yellow")).toHaveCount(0);
});

test("22:00 keeps the clock and draws no station tiles", async ({ page }) => {
  await page.clock.install({ time: at("22:00:00") });
  await openWall(page, {
    board: "caja",
    date,
    stations: [station("yellow", "Yellow 1", 1)],
    shifts: [shift("ana", "Ana", "yellow", 12)],
  });
  await expect(page.getByTestId("wall-hour")).toContainText("Outside service hours");
  await expect(page.getByTestId("wall-clock")).toBeVisible();
  await expect(page.getByTestId("wall-station-yellow")).toHaveCount(0);
});
