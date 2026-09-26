import { test, expect, type Page } from "@playwright/test";

type Day = {
  stations: { id: string; maxConcurrent: number }[];
  shifts: {
    id: string;
    startAt: string;
    employee: { abilities: { stationId: string; level: string }[] };
    assignments: { id: string; stationId: string; hourStart: string }[];
  }[];
};

async function unlock(page: Page) {
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("2468");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("manager-color-editor")).toBeVisible();
}

async function loadSample(page: Page) {
  await unlock(page);
  const daysResponse = await page.request.get("/api/days");
  const days = await daysResponse.json() as { dates: string[] };
  if (!days.dates.includes("2026-09-20")) {
    await page.getByTestId("toolbar-more").click();
    await page.getByTestId("load-sample").click();
    await expect(page.getByTestId("toast")).toContainText(/Loaded sample|Muestra cargada/i);
    await page.getByTestId("toolbar-more").click();
  }
  await page.getByTestId("compact-date").selectOption("2026-09-20");
  await expect(page.getByTestId("paint-matrix").locator("td[data-kind='open'] button").first()).toBeVisible();
}

function chicagoHour(instant: string): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23",
  }).format(new Date(instant)));
}

async function stageOpenHour(page: Page) {
  const cell = page.getByTestId("paint-matrix").locator("td[data-kind='open'] button").first();
  const id = await cell.getAttribute("data-testid");
  const match = /^paint-cell-(.+)-(\d{1,2})$/.exec(id ?? "");
  expect(match).not.toBeNull();
  const shiftId = match![1]!;
  const hour = Number(match![2]);
  const response = await page.request.get("/api/boards/caja/days/2026-09-20");
  expect(response.ok()).toBe(true);
  const day = await response.json() as Day;
  const shift = day.shifts.find((s) => s.id === shiftId);
  expect(shift).toBeDefined();
  const station = day.stations.find((candidate) =>
    candidate.maxConcurrent > 0 &&
    !shift!.employee.abilities.some((a) => a.stationId === candidate.id && a.level === "forbidden") &&
    day.shifts.flatMap((s) => s.assignments).filter((a) =>
      a.stationId === candidate.id && chicagoHour(a.hourStart) === hour,
    ).length < candidate.maxConcurrent,
  );
  expect(station).toBeDefined();
  await page.getByTestId(`paint-palette-${station!.id}`).click();
  await cell.click();
  await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
  return { shiftId, hour, stationId: station!.id };
}

test.describe("condensed staff board and manager color editor", () => {
  test.use({ viewport: { width: 820, height: 1080 } });

  test("staff sees a compact schedule; painted cells publish only on Guardar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    await expect(page.getByTestId("schedule-panel")).toBeVisible();
    await expect(page.getByTestId("compact-toolbar")).toBeVisible();
    await expect(page.getByTestId("manager-color-editor")).toHaveCount(0);
    await expect(page.getByTestId("traffic-meters")).toHaveCount(0);
    await page.getByTestId("toolbar-more").click();
    await expect(page.getByTestId("view-toggle-timeline")).toHaveCount(0);
    await page.getByTestId("toolbar-more").click();

    await loadSample(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const firstPosition = page.getByTestId("paint-palette").locator("button").first();
    const paletteGeometry = await firstPosition.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      contentWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(paletteGeometry.width).toBeGreaterThanOrEqual(130);
    expect(paletteGeometry.scrollWidth).toBeLessThanOrEqual(paletteGeometry.contentWidth + 1);
    await firstPosition.click();
    await expect(page.getByTestId("paint-selected")).not.toContainText("—");
    await page.setViewportSize({ width: 820, height: 1080 });
    const target = await stageOpenHour(page);
    const before = await page.request.get("/api/boards/caja/days/2026-09-20");
    const beforeDay = await before.json() as Day;
    expect(beforeDay.shifts.find((s) => s.id === target.shiftId)?.assignments.some((a) =>
      a.stationId === target.stationId && chicagoHour(a.hourStart) === target.hour,
    )).toBe(false);

    await page.getByTestId("paint-undo").click();
    await expect(page.getByTestId("paint-pending")).toContainText(/0 cambios pendientes|0 pending changes/i);
    await stageOpenHour(page);
    await page.getByTestId("paint-save").click();
    await expect(page.getByTestId("paint-feedback")).toContainText(/Guardado|Saved/i);
    const after = await page.request.get("/api/boards/caja/days/2026-09-20");
    const afterDay = await after.json() as Day;
    expect(afterDay.shifts.find((s) => s.id === target.shiftId)?.assignments.some((a) =>
      a.stationId === target.stationId && chicagoHour(a.hourStart) === target.hour,
    )).toBe(true);

    await page.getByTestId("compact-manager").click();
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    await expect(page.getByTestId("schedule-panel")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("schedule-grid")).toBeVisible();
    const headerHeight = await page.locator("header").evaluate((el) => el.getBoundingClientRect().height);
    expect(headerHeight).toBeLessThan(230);
  });

  test("navigation, manual lock, idle and reload recover the same manager's draft", async ({ page }) => {
    await page.goto("/");
    await loadSample(page);
    await stageOpenHour(page);
    await page.getByTestId("compact-view").selectOption("schedule");
    await expect(page.getByTestId("schedule-panel")).toBeVisible();
    await page.getByTestId("compact-view").selectOption("timeline");
    await expect(page.getByTestId("paint-restored")).toBeVisible();
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.getByTestId("compact-manager").click();
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    await expect(page.getByTestId("manager-color-editor")).toHaveCount(0);
    await expect(page.getByTestId("compact-date").locator("option[value='2026-09-20']")).not.toContainText(/borrador|draft/i);
    await unlock(page);
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.waitForTimeout(2200);
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    await expect(page.getByTestId("manager-color-editor")).toHaveCount(0);
    await unlock(page);
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.reload();
    await unlock(page);
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-restored")).toBeVisible();
    await page.getByTestId("paint-discard").click();
    await expect(page.getByTestId("paint-pending")).toContainText(/0 cambios pendientes|0 pending changes/i);
  });

  test("automatic date and offline-cache changes retain a private draft without writing", async ({ page }) => {
    await page.clock.install();
    await page.route("**/api/managers", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const body = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
    });
    const paintWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().endsWith("/api/assignments/paint")) {
        paintWrites.push(request.url());
      }
    });
    await page.goto("/");
    await loadSample(page);
    await stageOpenHour(page);

    await page.route("**/api/days", (route) => route.fulfill({ json: { dates: ["2026-09-21"] } }));
    await page.clock.fastForward(30_100);
    await expect(page.getByTestId("compact-date")).toHaveValue("2026-09-20");
    await expect(page.getByTestId("compact-date").locator("option[value='2026-09-20']")).toContainText(/borrador|draft/i);
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    expect(paintWrites).toHaveLength(0);

    await page.unroute("**/api/days");
    const cacheResponse = await page.request.get("/api/boards/caja/days/2026-09-21");
    const cachedDay = await cacheResponse.json();
    await page.evaluate((day) => localStorage.setItem("taco-oasis-last-board-v1", JSON.stringify({
      version: 1, board: "caja", date: "2026-09-21", day, savedAt: new Date().toISOString(),
    })), cachedDay);
    await page.route("**/api/boards/caja/days/2026-09-20", (route) => route.abort("failed"));
    await page.clock.fastForward(30_100);
    await expect(page.getByTestId("compact-date")).toHaveValue("2026-09-21");
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await page.unroute("**/api/boards/caja/days/2026-09-20");
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-restored")).toBeVisible();
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await expect(page.getByTestId("paint-save")).toBeEnabled();
    expect(paintWrites).toHaveLength(0);
  });

  test("a changed shift blocks stale publication and a failed save keeps the draft", async ({ page }) => {
    await page.route("**/api/managers", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const body = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
    });
    await page.goto("/");
    await loadSample(page);
    const target = await stageOpenHour(page);
    await page.getByTestId("compact-date").selectOption("2026-09-21");
    await page.route("**/api/boards/caja/days/2026-09-20", async (route) => {
      const response = await route.fetch();
      const day = await response.json() as Day & { shifts: (Day["shifts"][number] & { startAt: string })[] };
      const shift = day.shifts.find((candidate) => candidate.id === target.shiftId)!;
      shift.startAt = new Date(new Date(shift.startAt).getTime() + 60_000).toISOString();
      await route.fulfill({ response, json: day });
    });
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-stale-list")).toBeVisible();
    await expect(page.getByTestId("paint-save")).toBeDisabled();
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);

    await page.unroute("**/api/boards/caja/days/2026-09-20");
    await page.getByTestId("compact-date").selectOption("2026-09-21");
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-restored")).toBeVisible();
    await expect(page.getByTestId("paint-save")).toBeEnabled();
    await page.route("**/api/assignments/paint", (route) => route.abort("failed"));
    await page.getByTestId("paint-save").click();
    await expect(page.getByTestId("paint-feedback")).toContainText(/No se pudieron|Could not save/i);
    await page.getByTestId("compact-view").selectOption("schedule");
    await page.getByTestId("compact-view").selectOption("timeline");
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.unroute("**/api/assignments/paint");
  });

  test("a different manager does not inherit the retained draft", async ({ page }) => {
    let nextManagerId: string | null = null;
    await page.route("**/api/managers", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const body = await response.json() as { manager: { id: string; name: string } };
      await route.fulfill({ response, json: {
        ...body,
        idleMs: 120_000,
        manager: nextManagerId ? { ...body.manager, id: nextManagerId, name: "Other manager" } : body.manager,
      } });
    });
    await page.goto("/");
    await loadSample(page);
    await stageOpenHour(page);
    await page.getByTestId("compact-manager").click();
    nextManagerId = "separate-manager-e2e";
    await unlock(page);
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-pending")).toContainText(/0 cambios pendientes|0 pending changes/i);
    await expect(page.getByTestId("paint-restored")).toHaveCount(0);
    await expect(page.getByTestId("compact-date").locator("option[value='2026-09-20']")).not.toContainText(/borrador|draft/i);
    await page.getByTestId("compact-manager").click();
    nextManagerId = null;
    await unlock(page);
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.getByTestId("paint-discard").click();
  });

  test("local draft storage failure stays honest through a board conflict", async ({ page }) => {
    await page.clock.install();
    await page.route("**/api/managers", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const body = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
    });
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith("taco-oasis-paint-draft-v1")) throw new DOMException("Storage unavailable", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    await page.goto("/");
    await loadSample(page);
    const target = await stageOpenHour(page);
    await expect(page.getByTestId("paint-storage-error")).toBeVisible();
    const response = await page.request.get("/api/boards/caja/days/2026-09-20");
    const day = await response.json() as Day;
    expect(day.shifts.find((shift) => shift.id === target.shiftId)?.assignments.some((assignment) =>
      assignment.stationId === target.stationId && chicagoHour(assignment.hourStart) === target.hour,
    )).toBe(false);
    await page.route("**/api/boards/caja/days/2026-09-20", async (route) => {
      const fresh = await route.fetch();
      const changed = await fresh.json() as Day;
      const shift = changed.shifts.find((candidate) => candidate.id === target.shiftId)!;
      shift.startAt = new Date(new Date(shift.startAt).getTime() + 60_000).toISOString();
      await route.fulfill({ response: fresh, json: changed });
    });
    await page.clock.fastForward(30_100);
    await expect(page.getByTestId("paint-stale-list")).toBeVisible();
    await expect(page.getByTestId("paint-feedback")).not.toContainText(/kept on this device|guardamos tu borrador/i);
    await expect(page.getByTestId("paint-storage-error")).toBeVisible();
    await expect(page.getByTestId("paint-save")).toBeDisabled();
  });

  test("concurrent assignment blocks Guardar and keeps the proposed edit", async ({ page }) => {
    await page.route("**/api/managers", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const body = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
    });
    await page.goto("/");
    await loadSample(page);
    const target = await stageOpenHour(page);
    await page.getByTestId("compact-date").selectOption("2026-09-21");
    await page.route("**/api/boards/caja/days/2026-09-20", async (route) => {
      const response = await route.fetch();
      const day = await response.json() as Day;
      const shift = day.shifts.find((candidate) => candidate.id === target.shiftId)!;
      shift.assignments.push({
        id: "concurrent-assignment-e2e",
        stationId: target.stationId,
        hourStart: new Date(Date.UTC(2026, 8, 20, target.hour + 5)).toISOString(),
      });
      await route.fulfill({ response, json: day });
    });
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-stale-list")).toBeVisible();
    await expect(page.getByTestId("paint-save")).toBeDisabled();
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.reload();
    await unlock(page);
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-stale-list")).toBeVisible();
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.getByTestId("paint-stale-list").getByRole("button").click();
    await expect(page.getByTestId("paint-pending")).toContainText(/0 cambios pendientes|0 pending changes/i);
  });
});
