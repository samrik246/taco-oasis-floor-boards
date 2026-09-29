import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ensureSampleLoaded } from "./load-sample-api";
import { PrismaClient } from "@prisma/client";

async function managerHeaders(page: Page) {
  const res = await page.request.post("/api/managers", { data: { code: "2468" } });
  expect(res.ok()).toBe(true);
  const { sessionToken } = await res.json() as { sessionToken: string };
  return { "x-manager-session": sessionToken };
}

async function keepDesk(page: Page) {
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
  });
}

async function unlock(page: Page) {
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("manager-color-editor")).toBeVisible();
}

async function loadSample(page: Page) {
  await unlock(page);
  if (await ensureSampleLoaded(page)) await unlock(page);
  await page.getByTestId("compact-date").selectOption("2026-09-20");
  await expect(page.getByTestId("paint-matrix").locator("td[data-kind='open'] button").first()).toBeVisible();
}

function chicagoHour(instant: string): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23",
  }).format(new Date(instant)));
}

async function paletteIds(page: Page): Promise<string[]> {
  return page.getByTestId("paint-palette").locator("button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("data-testid") ?? ""),
  );
}

async function forbiddenStationIds(employeeId: string): Promise<Set<string>> {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("FLOOR_BOARDS_TEST_ROOT is missing");
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } },
  });
  try {
    const rows = await prisma.employeeStationAbility.findMany({
      where: { employeeId, level: "forbidden" },
      select: { stationId: true },
    });
    return new Set(rows.map((row) => row.stationId));
  } finally {
    await prisma.$disconnect();
  }
}

test("H4 erase sits left of undo, selects, and clears a saved cell", async ({ page }) => {
  await keepDesk(page);
  await page.goto("/");
  await loadSample(page);
  await expect(page.getByTestId("manager-color-editor")).not.toContainText("Elige un puesto o Borrar; luego toca una hora.");
  await expect(page.getByTestId("manager-color-editor")).not.toContainText("Pick a position or Erase, then tap an hour.");
  await expect(page.getByTestId("paint-discard")).toHaveCount(0);
  await expect(page.getByTestId("paint-sort-name")).toHaveCount(0);
  await expect(page.locator("[data-testid^='paint-palette-family:']")).toHaveCount(0);
  await expect(page.getByTestId("paint-undo")).toHaveClass(/bg-amber-400/);
  await expect(page.getByTestId("paint-undo")).toHaveClass(/text-neutral-950/);
  await expect(page.getByTestId("paint-palette-erase")).toHaveClass(/border-red-700/);
  await expect(page.getByTestId("paint-palette-erase")).toHaveClass(/bg-white/);
  await expect(page.getByTestId("paint-palette-erase")).toHaveClass(/text-red-800/);
  await expect(page.getByTestId("paint-save")).toHaveClass(/bg-emerald-600/);
  await expect(page.getByTestId("paint-save")).toHaveClass(/text-white/);
  await page.getByTestId("toolbar-hide").click();
  await expect(page.getByTestId("paint-controls-slot").getByTestId("paint-controls")).toHaveAttribute("data-folded", "1");
  await expect(page.getByTestId("toolbar-show")).toBeVisible();
  await page.getByTestId("toolbar-show").click();
  await expect(page.getByTestId("paint-controls")).toHaveAttribute("data-folded", "0");
  await expect(page.getByTestId("paint-controls-slot")).toHaveCount(0);

  const before = await paletteIds(page);
  expect(before.some((id) => id.startsWith("paint-palette-family:"))).toBe(false);
  const cell = page.getByTestId("paint-matrix").locator("td[data-kind='open'] button").first();
  const match = /^paint-cell-(.+)-(\d{1,2})$/.exec(await cell.getAttribute("data-testid") ?? "");
  expect(match).not.toBeNull();
  const shiftId = match![1]!;
  const hour = Number(match![2]);
  const response = await page.request.get("/api/boards/caja/days/2026-09-20", { headers: await managerHeaders(page) });
  const day = await response.json() as {
    stations: { id: string; maxConcurrent: number }[];
    shifts: { id: string; employee: { id: string }; assignments: { stationId: string; hourStart: string }[] }[];
    stationUse: { stationId: string; count: number }[];
  };
  for (const row of day.stationUse) {
    expect(Object.keys(row).sort()).toEqual(["count", "stationId"]);
  }
  const shift = day.shifts.find((row) => row.id === shiftId);
  expect(shift).toBeDefined();
  const forbidden = await forbiddenStationIds(shift!.employee.id);
  const station = day.stations.find((candidate) =>
    candidate.maxConcurrent > 0 &&
    !forbidden.has(candidate.id) &&
    day.shifts.flatMap((row) => row.assignments).filter((assignment) =>
      assignment.stationId === candidate.id && chicagoHour(assignment.hourStart) === hour,
    ).length < candidate.maxConcurrent,
  );
  expect(station).toBeDefined();
  await page.getByTestId(`paint-palette-${station!.id}`).click();
  const picked = page.getByTestId(`paint-palette-${station!.id}`);
  await expect(picked).toHaveAttribute("data-selected-top", "white");
  await expect(picked).toHaveClass(/ring-2/);
  await expect(picked.locator("span.bg-white")).toBeVisible();
  await cell.click();
  expect(await paletteIds(page)).toEqual(before);
  await page.getByTestId("paint-save").click();
  await expect(page.getByTestId("paint-feedback")).toContainText(/Guardado|Saved/i);

  const erase = page.getByTestId("paint-palette-erase");
  const undo = page.getByTestId("paint-undo");
  await expect(page.getByTestId("paint-palette").locator("[data-testid='paint-palette-erase']")).toHaveCount(0);
  expect(await undo.evaluate((element) => element.nextElementSibling?.getAttribute("data-testid"))).toBe("paint-palette-erase");
  expect(await erase.evaluate((element) => element.nextElementSibling?.getAttribute("data-testid"))).toBe("paint-save");
  await expect(undo).toBeVisible();
  await erase.click();
  await expect(erase).toHaveAttribute("aria-pressed", "true");
  await expect(erase).toHaveClass(/ring-2/);
  await expect(page.getByTestId("paint-selected")).toContainText(/Borrar|Erase/);

  await page.getByTestId(`paint-cell-${shiftId}-${hour}`).click();
  const dialog = page.getByTestId("paint-reason-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Guardar|Save/ }).click();
  await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
  const cleared = page.getByTestId(`paint-cell-${shiftId}-${hour}`);
  await expect(cleared.locator("xpath=..")).toHaveAttribute("data-pending", "1");
  await expect(cleared).not.toContainText(/Libre|Open/);
  await expect(cleared).toHaveAttribute("aria-label", /Libre|Open/);
  await page.getByTestId("paint-save").click();
  await expect(page.getByTestId("paint-feedback")).toContainText(/Guardado|Saved/i);

  const after = await page.request.get("/api/boards/caja/days/2026-09-20", { headers: await managerHeaders(page) });
  const afterDay = await after.json() as typeof day;
  expect(afterDay.shifts.find((row) => row.id === shiftId)?.assignments.some((assignment) =>
    assignment.stationId === station!.id && chicagoHour(assignment.hourStart) === hour,
  )).toBe(false);
});
