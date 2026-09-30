import { ownerShortIdle } from "./owner-short-idle";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { test, expect, type Page, type Request } from "@playwright/test";
import { ensureSampleLoaded } from "./load-sample-api";
import { PrismaClient } from "@prisma/client";

test.beforeEach(async ({ page }) => { await ownerShortIdle(page); });

/** Planned days are manager-only on the API too; sign in the test's own request context. */
async function managerHeaders(page: Page) {
  const res = await page.request.post("/api/managers", { data: { code: "8642" } });
  expect(res.ok()).toBe(true);
  const { sessionToken } = await res.json() as { sessionToken: string };
  return { "x-manager-session": sessionToken };
}

type Day = {
  stations: { id: string; maxConcurrent: number }[];
  shifts: {
    id: string;
    startAt: string;
    employee: { id: string };
    assignments: { id: string; stationId: string; hourStart: string }[];
  }[];
};

/** The manager day payload no longer carries levels. The fixture may. */
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

async function unlock(page: Page) {
  await page.getByTestId("compact-manager").click();
  await page.getByTestId("manager-code-input").fill("8642");
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

async function stageOpenHour(page: Page) {
  const cell = page.getByTestId("paint-matrix").locator("td[data-kind='open'] button").first();
  const id = await cell.getAttribute("data-testid");
  const match = /^paint-cell-(.+)-(\d{1,2})$/.exec(id ?? "");
  expect(match).not.toBeNull();
  const shiftId = match![1]!;
  const hour = Number(match![2]);
  const response = await page.request.get("/api/boards/caja/days/2026-09-20", { headers: await managerHeaders(page) });
  expect(response.ok()).toBe(true);
  const day = await response.json() as Day;
  const shift = day.shifts.find((s) => s.id === shiftId);
  expect(shift).toBeDefined();
  const forbidden = await forbiddenStationIds(shift!.employee.id);
  const station = day.stations.find((candidate) =>
    candidate.maxConcurrent > 0 &&
    !forbidden.has(candidate.id) &&
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

  test("numbered seats stay on the palette and a specific seat writes no family", async ({ page }) => {
    // Palette coverage loads a sample and inspects both boards; the CI-only
    // 1.5-second manager timeout is exercised by its dedicated idle tests.
    await page.route("**/api/managers", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const body = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
    });
    const families = {
      caja: {
        green: [["green1", "Green 1", "light-green"], ["green2", "Green 2 / Jolt", "dark-green"]],
        purple: [["purple1", "Purple 1", "purple"], ["purple2", "Purple 2", "violet"]],
        nieves: [["nieves", "Nieves 1", "light-pink"], ["nieves2", "Nieves 2", "dark-pink"]],
        yellow: [["yellow", "Yellow / Outside", "yellow"], ["yellow2", "Yellow 2", "gold"]],
      },
      cocina: {
        preparacion: [["pdf_pr1e", "Preparación 1", "light-green"], ["pdf_pr2e", "Preparación 2", "green"], ["pdf_pr3e", "Preparación 3", "dark-green"]],
        tortillaFreidora: [["pdf_tf1r", "Tortilla Freidora 1", "yellow"], ["pdf_tf2r", "Tortilla Freidora 2", "gold"]],
        taquero: [["pdf_tq1r", "Taquero 1 + Relleno", "light-red"], ["pdf_tq2r", "Taquero 2 + Relleno", "red"], ["pdf_tq3r", "Taquero 3", "maroon"]],
        birria: [["pdf_br1a", "Birria 1", "light-brown"], ["pdf_br2a", "Birria 2", "brown"]],
        trastes: [["pdf_tsrea", "Trastes + Tareas 1", "light-sky"], ["pdf_tsr2", "Trastes 2", "sky"], ["pdf_tsr3", "Trastes + Tareas 3", "dark-sky"], ["pdf_tsr4", "Trastes + Tareas 4", "deep-sky"]],
      },
    } as const;
    await page.route("**/api/boards/*/days/2026-09-20", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const day = await response.json() as { stations: { id: string; label: string; color: string; sortOrder: number; shortCode?: string }[] };
      if (!Array.isArray(day.stations) || day.stations.length === 0) {
        return route.fulfill({ response });
      }
      const board = route.request().url().includes("/cocina/") ? "cocina" : "caja";
      const template = day.stations[0]!;
      for (const members of Object.values(families[board])) {
        for (const [id, label, color] of members) {
          const station = day.stations.find((candidate) => candidate.id === id);
          if (station) Object.assign(station, { label, color });
          else day.stations.push({ ...template, id, label, color, sortOrder: day.stations.length + 100 });
        }
      }
      await route.fulfill({ response, json: day });
    });
    await page.goto("/");
    await loadSample(page);
    await expect(page.locator("[data-testid^='paint-palette-family:']")).toHaveCount(0);
    for (const members of Object.values(families.caja)) {
      for (const [id] of members) await expect(page.getByTestId(`paint-palette-${id}`)).toBeVisible();
    }
    await page.getByTestId("paint-palette-green2").click();
    await expect(page.getByTestId("paint-selected")).toContainText("Green 2 / Jolt");
    const painted = await stageOpenHour(page);
    const draft = await page.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.startsWith("taco-oasis-paint-draft-v1:") && !key.includes(":dates:"))
      .map(([, value]) => JSON.parse(value) as { edits: { family?: string; stationId: string | null }[] }));
    const edits = draft.flatMap((item) => item.edits);
    expect(edits.some((edit) => edit.family)).toBe(false);
    expect(edits).toEqual(expect.arrayContaining([
      expect.objectContaining({ stationId: painted.stationId }),
    ]));
    await page.reload();
    await unlock(page);
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-restored")).toBeVisible();
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.screenshot({ path: "test-results/nine-family-caja.png", fullPage: true });
    await page.getByTestId("compact-board").selectOption("cocina");
    await expect(page.locator("[data-testid^='paint-palette-family:']")).toHaveCount(0);
    for (const members of Object.values(families.cocina)) {
      for (const [id] of members) await expect(page.getByTestId(`paint-palette-${id}`)).toBeVisible();
    }
    await page.screenshot({ path: "test-results/nine-family-cocina.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ["pdf_tq1r", "pdf_tq3r", "pdf_tsrea", "pdf_tsr4"]) {
      const choice = page.getByTestId(`paint-palette-${id}`);
      await choice.scrollIntoViewIfNeeded();
      await expect(choice).toBeInViewport();
      const size = await choice.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        contentWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(size.width).toBeGreaterThanOrEqual(130);
      expect(size.width).toBeLessThanOrEqual(200);
      expect(size.scrollWidth).toBeLessThanOrEqual(size.contentWidth + 1);
    }
    await page.getByTestId("paint-palette-pdf_tq1r").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/nine-family-cocina-phone-taquero.png" });
    await page.getByTestId("paint-palette-pdf_tsrea").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/nine-family-cocina-phone-trastes.png" });
  });

  test("an incomplete family leaves its concrete slot available without offering Auto", async ({ page }) => {
    await page.route("**/api/boards/caja/days/2026-09-20", async (route) => {
      const response = await route.fetch();
      const day = await response.json() as { stations: { id: string; label: string; color: string; sortOrder: number }[] };
      const first = day.stations[0]!;
      day.stations = day.stations.filter((station) => station.id !== "green2");
      if (!day.stations.some((station) => station.id === "green1")) {
        day.stations.push({ ...first, id: "green1", label: "Green 1", color: "green", sortOrder: 100 });
      }
      await route.fulfill({ response, json: day });
    });
    await page.goto("/");
    await loadSample(page);
    await expect(page.getByTestId("paint-palette-family:green")).toHaveCount(0);
    await expect(page.getByTestId("paint-palette-green1")).toBeVisible();
  });

  test("staff sees a compact schedule; painted cells publish only on Guardar", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/(?!.*kiosk=1)/);
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    await expect(page.getByTestId("open-descansos")).toBeVisible();
    await expect(page.getByTestId("schedule-panel")).toBeVisible();
    await expect(page.getByTestId("compact-toolbar")).toBeVisible();
    await expect(page.getByTestId("manager-color-editor")).toHaveCount(0);
    await expect(page.getByTestId("traffic-meters")).toHaveCount(0);
    await page.getByTestId("toolbar-more").click();
    await expect(page.getByTestId("view-toggle-timeline")).toHaveCount(0);
    await page.getByTestId("toolbar-more").click();

    await loadSample(page);
    await expect(page.getByTestId("open-descansos")).toBeVisible();
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
    const before = await page.request.get("/api/boards/caja/days/2026-09-20", { headers: await managerHeaders(page) });
    const beforeDay = await before.json() as Day;
    expect(beforeDay.shifts.find((s) => s.id === target.shiftId)?.assignments.some((a) =>
      a.stationId === target.stationId && chicagoHour(a.hourStart) === target.hour,
    )).toBe(false);

    await page.getByTestId("paint-undo").click();
    await expect(page.getByTestId("paint-pending")).toContainText(/0 cambios pendientes|0 pending changes/i);
    await stageOpenHour(page);
    await page.getByTestId("paint-save").click();
    await expect(page.getByTestId("paint-feedback")).toContainText(/Guardado|Saved/i);
    const after = await page.request.get("/api/boards/caja/days/2026-09-20", { headers: await managerHeaders(page) });
    const afterDay = await after.json() as Day;
    expect(afterDay.shifts.find((s) => s.id === target.shiftId)?.assignments.some((a) =>
      a.stationId === target.stationId && chicagoHour(a.hourStart) === target.hour,
    )).toBe(true);

    await page.getByTestId("compact-manager").click();
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    // Staff see today only: the lock drops the planned day.
    await expect(page.getByTestId("compact-date")).not.toHaveValue("2026-09-20");
    await expect(page.getByTestId("schedule-panel")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
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
    // Staff see today only: the planned day and its draft marker are gone from the list.
    await expect(page.getByTestId("compact-date").locator("option[value='2026-09-20']")).toHaveCount(0);
    await unlock(page);
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.waitForTimeout(2200);
    await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    await expect(page.getByTestId("manager-color-editor")).toHaveCount(0);
    await unlock(page);
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await page.reload();
    await unlock(page);
    await page.getByTestId("compact-date").selectOption("2026-09-20");
    await expect(page.getByTestId("paint-restored")).toBeVisible();
    await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
    await expect(page.getByTestId("paint-undo")).toBeDisabled();
  });

  test("automatic date and offline-cache changes retain a private draft without writing", async ({ page }, testInfo) => {
    // The offline cache holds Chicago today only, so the browser's today is the cached day.
    await page.clock.install({ time: new Date("2026-09-21T17:00:00Z") });
    await page.clock.pauseAt(new Date("2026-09-21T17:00:01Z"));
    await page.route("**/api/managers", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const body = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, idleMs: 120_000 } });
    });
    const paintWrites: string[] = [];
    let phase = "setup";
    const boardPath = /^\/api\/boards\/caja\/days\/2026-09-(20|21)$/;
    const requests = new Map<Request, number>();
    const network: { id: number; phase: string; path: string; outcome: string; status?: number; error?: string }[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().endsWith("/api/assignments/paint")) {
        paintWrites.push(request.url());
      }
      const pathname = new URL(request.url()).pathname;
      if (boardPath.test(pathname)) {
        const id = requests.size + 1;
        requests.set(request, id);
        network.push({ id, phase, path: pathname, outcome: "request" });
      }
    });
    page.on("response", (response) => {
      const id = requests.get(response.request());
      if (id) network.push({ id, phase, path: new URL(response.url()).pathname, outcome: "response", status: response.status() });
    });
    page.on("requestfailed", (request) => {
      const id = requests.get(request);
      if (id) network.push({ id, phase, path: new URL(request.url()).pathname, outcome: "failed", error: request.failure()?.errorText });
    });
    const readDraft = () => page.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.startsWith("taco-oasis-paint-draft-v1:") && key.endsWith(":caja:2026-09-20"))
      .map(([key, raw]) => {
        const { version, edits } = JSON.parse(raw);
        return { key, version, edits };
      }));
    try {
      await page.goto("/");
      await loadSample(page);
      const target = await stageOpenHour(page);
      const draft = await readDraft();
      expect(draft).toHaveLength(1);
      expect(draft[0]!.edits).toEqual([expect.objectContaining(target)]);
      const headers = await managerHeaders(page);
      const beforeResponse = await page.request.get("/api/boards/caja/days/2026-09-20", { headers });
      expect(beforeResponse.ok()).toBe(true);
      const before = await beforeResponse.json() as Day;

      phase = "date-removed";
      await page.route("**/api/days", (route) => route.fulfill({ json: { dates: ["2026-09-21"] } }));
      const [datesResponse, plannedResponse] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === "/api/days" && response.ok()),
        page.waitForResponse((response) => response.url().endsWith("/api/boards/caja/days/2026-09-20") && response.ok()),
        page.clock.fastForward(30_100),
      ]);
      expect(await datesResponse.json()).toEqual({ dates: ["2026-09-21"] });
      await plannedResponse.finished();
      await expect(page.getByTestId("compact-date")).toHaveValue("2026-09-20");
      await expect(page.getByTestId("compact-date").locator("option[value='2026-09-20']")).toContainText(/borrador|draft/i);
      await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
      expect(paintWrites).toHaveLength(0);

      await page.unroute("**/api/days");
      const cacheResponse = await page.request.get("/api/boards/caja/days/2026-09-21", { headers });
      expect(cacheResponse.ok()).toBe(true);
      const cachedDay = await cacheResponse.json();
      await page.evaluate((day) => localStorage.setItem("taco-oasis-last-board-v1", JSON.stringify({
        version: 1, board: "caja", date: "2026-09-21", day, savedAt: new Date().toISOString(),
      })), cachedDay);
      // Fallback changes the selected date and immediately fetches that date.
      // Both requests must fail until the test deliberately restores connectivity.
      let boardsOffline = true;
      await page.route(/\/api\/boards\/caja\/days\/2026-09-(20|21)$/, (route) =>
        boardsOffline ? route.abort("failed") : route.continue());
      phase = "offline";
      await Promise.all([
        page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/boards/caja/days/2026-09-20")),
        page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/boards/caja/days/2026-09-21")),
        page.clock.fastForward(30_100),
      ]);
      await expect(page.getByTestId("compact-date")).toHaveValue("2026-09-21");
      await expect(page.getByTestId("offline-banner")).toBeVisible();
      await expect(page.getByTestId("floor-board")).toHaveAttribute("data-offline", "1");
      await expect(page.getByTestId("paint-matrix")).toBeVisible();
      await expect(page.getByTestId("paint-save")).toBeDisabled();
      await expect(page.getByTestId("paint-pending")).toContainText(/0 cambios pendientes|0 pending changes/i);
      await expect(page.getByTestId("compact-date").locator("option[value='2026-09-20']")).toContainText(/borrador|draft/i);
      expect(await readDraft()).toEqual(draft);
      expect(network.filter((event) => event.phase === "offline" && event.outcome === "response")).toEqual([]);
      expect(paintWrites).toHaveLength(0);

      phase = "reconnected";
      boardsOffline = false;
      const [liveResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith("/api/boards/caja/days/2026-09-21") && response.ok()),
        page.getByTestId("refresh-day").click(),
      ]);
      await liveResponse.finished();
      await expect(page.getByTestId("offline-banner")).toHaveCount(0);
      await expect(page.getByTestId("floor-board")).toHaveAttribute("data-offline", "0");
      await expect(page.getByTestId("compact-date")).toHaveValue("2026-09-21");
      expect(await readDraft()).toEqual(draft);

      phase = "draft-restored";
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith("/api/boards/caja/days/2026-09-20") && response.ok()),
        page.getByTestId("compact-date").selectOption("2026-09-20"),
      ]);
      await expect(page.getByTestId("paint-restored")).toBeVisible();
      await expect(page.getByTestId("paint-pending")).toContainText(/1 cambio pendiente|1 pending change/i);
      await expect(page.getByTestId("paint-save")).toBeEnabled();
      expect(await readDraft()).toEqual(draft);
      const afterResponse = await page.request.get("/api/boards/caja/days/2026-09-20", { headers });
      expect(afterResponse.ok()).toBe(true);
      const after = await afterResponse.json() as Day;
      expect(after.shifts.map(({ id, assignments }) => ({ id, assignments })))
        .toEqual(before.shifts.map(({ id, assignments }) => ({ id, assignments })));
      expect(paintWrites).toHaveLength(0);
    } finally {
      // Persist outcomes even on failure, without credentials, headers or roster payloads.
      const evidencePath = testInfo.outputPath("offline-board-network.json");
      await writeFile(evidencePath, JSON.stringify({ phase, network, paintWrites }, null, 2));
      await testInfo.attach("offline-board-network", { path: evidencePath, contentType: "application/json" });
    }
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
    const response = await page.request.get("/api/boards/caja/days/2026-09-20", { headers: await managerHeaders(page) });
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
