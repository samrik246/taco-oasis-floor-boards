import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { safeDatabasePath } from "../scripts/test-db-path.cjs";
import { belowToolbar, viewportEvidence } from "./fixtures/q1-visibility";
import { observeCellClick } from "./fixtures/q1-click-evidence";
import type { DraftGeneration, DraftHead } from "../src/lib/quarter/client/draft-types";
import type { PublicDayV2 } from "../src/lib/quarter/client/day";
import { displayStationLabel } from "../src/lib/i18n";
import preservationColumns from "../src/lib/quarter/preservation-columns.json";

const date = "2041-10-12", origin = "http://floor-boards.test:3100";
const ids = ["caja", "cocina"].flatMap(board => [`q1-${board}-full`, `q1-${board}-tail`]);
let db: PrismaClient, active = false;
const requests: string[] = [];
test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });
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
  await expect(page.getByTestId("quarter-save")).toBeEnabled();
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
  test.setTimeout(600_000); await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem("taco-oasis-locale-v1", "en"));
  await open(page, board); expect(await page.evaluate(() => isSecureContext)).toBe(false);
  const full = `q1-${board}-full`, tail = `q1-${board}-tail`, station = `q1-${board}-a`;
  await page.getByTestId("q1-hour-header-11").getByRole("button").click();
  await expect(page.getByTestId(`quarter-cell-${full}-11`)).toBeEnabled();
  await page.getByTestId(`quarter-cell-${full}-11`).click();
  await expect(page.getByTestId("q1-interval-detail")).toBeVisible();
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(0);
  const overview = await page.getByTestId(`q1-hour-cell-${full}-11`).boundingBox();
  const height = await page.getByTestId(`q1-row-${full}`).evaluate(e => e.getBoundingClientRect().height);
  await expect(page.getByTestId("q1-zoom")).toHaveText("Split hour");
  await page.getByTestId("q1-zoom").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("q1-zoom")).toHaveText("Whole hours");
  const expanded = await page.getByTestId(`q1-hour-cell-${full}-11`).boundingBox();
  expect(expanded!.width / overview!.width).toBeCloseTo(4, 2);
  expect(await page.getByTestId(`q1-row-${full}`).evaluate(e => e.getBoundingClientRect().height)).toBe(height);
  const scroll = await page.getByTestId("q1-grid-scroll").boundingBox();
  expect(Math.abs(expanded!.x + expanded!.width / 2 - (scroll!.x + (scroll!.width + 176) / 2))).toBeLessThan(3);
  for (const [minute, count] of [[0, 2], [15, 2], [30, 1], [45, 1]]) await expect(page.getByTestId(`q1-count-12-${minute}`).locator("strong")).toHaveText(String(count));
  await page.getByTestId(`quarter-palette-${station}`).click();
  await page.getByTestId(`quarter-cell-${full}-11-15`).click();
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(1);
  const pending = page.getByTestId("quarter-private-preview");
  expect(await pending.evaluate(el => getComputedStyle(el).borderTopStyle)).toBe("dashed");
  const pendingShots = join(process.env.FLOOR_BOARDS_TEST_ROOT!, "painter-go-screens"); mkdirSync(pendingShots, { recursive: true });
  await page.screenshot({ path: join(pendingShots, `${board}-private-dashed.png`) });
  // Inicio changes routes without moving the floor token into the desk or
  // rewriting the private draft's heads/generations/submissions.
  const retained = () => page.evaluate(() => new Promise<Record<string, unknown[]>>((resolve, reject) => {
    const request = indexedDB.open("taco-oasis-paint-drafts");
    request.onerror = () => reject(request.error); request.onsuccess = () => {
      const database = request.result, names = ["heads", "generations", "submissions", "v1Archives"], result: Record<string, unknown[]> = {};
      const transaction = database.transaction(names, "readonly");
      for (const name of names) { const read = transaction.objectStore(name).getAll(); read.onsuccess = () => { result[name] = read.result; }; }
      transaction.oncomplete = () => { database.close(); resolve(result); }; transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
  const beforeNavigation = await retained();
  await page.getByTestId("toolbar-hide").click();
  await expect(page.getByTestId(`quarter-palette-${station}`)).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("toolbar-show").click();
  expect(await retained()).toEqual(beforeNavigation);
  await page.getByTestId("inicio-link").click(); await page.getByTestId("inicio-floor").click();
  if (await page.getByTestId("floor-board").getAttribute("data-role") !== "manager") {
    await page.getByTestId("compact-manager").click(); await page.getByTestId("manager-code-input").fill("e2e-second-owner"); await page.getByTestId("manager-unlock-submit").click();
  }
  await page.getByTestId("compact-date").selectOption(date); await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(1);
  expect(await retained()).toEqual(beforeNavigation);
  const navOutput = join(process.env.FLOOR_BOARDS_TEST_ROOT!, "release-a-screens"); mkdirSync(navOutput, { recursive: true });
  writeFileSync(join(navOutput, `${board}-private-navigation.json`), JSON.stringify({ before: beforeNavigation, after: await retained(), scope: "actual browser draft stores across folded controls and Inicio return" }, null, 2));
  if (await page.getByTestId("q1-grid-scroll").getAttribute("data-zoom") !== "quarter") await page.getByTestId("q1-zoom").click();
  await page.getByTestId(`quarter-palette-${station}`).click();
  await page.getByTestId(`quarter-cell-${tail}-11-30`).click(); await expect(page.getByTestId("quarter-private-preview")).toHaveCount(2);
  await page.getByTestId("q1-zoom").click();
  await belowToolbar(page, page.getByTestId(`q1-row-${full}`));
  const dragFrom = await page.getByTestId(`quarter-cell-${full}-11`).boundingBox(), dragTo = await page.getByTestId(`quarter-cell-${tail}-11`).boundingBox();
  const beforeRefusal = await retained();
  await page.mouse.move(dragFrom!.x + dragFrom!.width / 2, dragFrom!.y + 30); await page.mouse.down();
  await page.mouse.move(dragTo!.x + dragTo!.width / 2, dragTo!.y + 30, { steps: 10 }); await page.mouse.up();
  await expect(page.getByTestId("q1-error-summary").getByRole("button")).toHaveCount(2);
  await page.getByTestId("q1-error-summary").getByRole("button").nth(1).focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId(`quarter-cell-${tail}-11`)).toBeFocused();
  expect(await retained()).toEqual(beforeRefusal);
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 800 }); await page.getByTestId("q1-grid-scroll").evaluate(el => { el.scrollLeft += 35; }); await page.mouse.wheel(0, 80);
    await expect(page.getByTestId("q1-cell-notice")).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: join(navOutput, `${board}-multiple-errors-${width}.png`) });
  }
  writeFileSync(join(navOutput, `${board}-multiple-errors.json`), JSON.stringify({ errorCount: 2, before: beforeRefusal, after: await retained() }, null, 2));
  await page.getByTestId("q1-cell-notice").getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Discard draft", exact: true }).click(); await expect(page.getByTestId("quarter-private-preview")).toHaveCount(0);
  await page.getByTestId("q1-zoom").click(); await page.getByTestId(`quarter-cell-${full}-11-15`).click();
  await save(page);
  const first = await day(page, board), hour = first.hours.find(h => h.shiftId === full && h.hourStart === fromZonedTime(`${date}T11:00:00`, "America/Chicago").toISOString())!;
  expect(hour.intervals.filter(i => i.state === "assigned").map(i => [i.startAt, i.endAt, i.stationId])).toEqual([[fromZonedTime(`${date}T11:15:00`, "America/Chicago").toISOString(), fromZonedTime(`${date}T11:30:00`, "America/Chicago").toISOString(), station]]);
  await page.getByTestId("q1-zoom").click();
  await page.getByTestId(`quarter-cell-${full}-11`).click();
  await expect(page.getByTestId("q1-cell-notice")).toContainText("Mixed hour");
  const shots = join(process.env.FLOOR_BOARDS_TEST_ROOT!, "q1-grid-screens"); mkdirSync(shots, { recursive: true });
  await belowToolbar(page, page.getByTestId(`q1-row-${full}`));
  await viewportEvidence(page, join(shots, `${board}-mixed-refusal`), { notice: page.getByTestId("q1-cell-notice") });
  expect(await page.getByTestId("quarter-private-preview").count()).toBe(0);
  await page.getByTestId("q1-cell-notice").getByRole("button", { name: "Split hour" }).click();
  await expect(page.getByTestId("q1-grid-scroll")).toHaveAttribute("data-zoom", "quarter");
  // Five factual minutes occupy exactly one third of the last quarter; detail remains readable on tap.
  const partialCell = page.getByTestId(`quarter-cell-${tail}-12-15`);
  await expect(partialCell).toBeEnabled();
  await expect(page.getByTestId(`quarter-palette-${station}`)).toHaveAttribute("aria-pressed", "true");
  const beforePartial = await retained();
  const finishClickEvidence = await observeCellClick(page, `quarter-cell-${tail}-12-15`);
  try {
    await partialCell.click();
    await expect(partialCell.getByTestId("quarter-private-preview")).toHaveAttribute("aria-label", "Private: Q1 A · 12:15 PM–12:20 PM");
    await expect(page.getByTestId("quarter-save")).toBeEnabled();
    const stored = await retained(), heads = stored.heads as DraftHead[], generations = stored.generations as DraftGeneration[];
    const head = heads.find(h => h.board === board && h.date === date)!;
    const draft = generations.find(g => g.generationId === head.generationId)!;
    expect(draft.envelope.intents).toHaveLength(1);
    expect(draft.envelope.intents[0]).toMatchObject({
      intent: { shiftId: tail, quarter: "12:15", granularity: "quarter", action: "station", stationId: station },
      source: { shiftId: tail, endAt: fromZonedTime(`${date}T12:20:00`, "America/Chicago").toISOString() },
    });
  } finally {
    await finishClickEvidence(join(shots, `${board}-partial-click.json`), { before: beforePartial, after: await retained() });
    await page.screenshot({ path: join(shots, `${board}-partial-click.png`) });
  }
  await save(page);
  const part = page.getByTestId(`quarter-cell-${tail}-12-15`).locator('[data-kind="work"]').first();
  const partBox = await part.boundingBox(), slotBox = await page.getByTestId(`quarter-cell-${tail}-12-15`).boundingBox();
  expect(partBox!.width / slotBox!.width).toBeCloseTo(1 / 3, 2);
  await expect(part.getByTestId("saved-box-time")).toHaveCount(0);
  // Releasing an unfinished mouse gesture outside the grid must not paint later.
  const beforeCancelledGesture = await retained();
  const cancelledCell = page.getByTestId(`quarter-cell-${full}-11-30`);
  await cancelledCell.scrollIntoViewIfNeeded(); const cancelledBox = (await cancelledCell.boundingBox())!;
  await page.mouse.move(cancelledBox.x + cancelledBox.width / 2, cancelledBox.y + cancelledBox.height / 2); await page.mouse.down();
  await page.mouse.move(8, 400); await page.mouse.up();
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(0);
  expect(await retained()).toEqual(beforeCancelledGesture);
  const beforeKeyboardInspection = await retained();
  await page.getByTestId(`quarter-cell-${full}-11-30`).focus(); await page.keyboard.press("Tab");
  await expect(page.getByTestId(`quarter-cell-${full}-11-45`)).toBeFocused();
  await expect(page.getByTestId("q1-interval-detail")).toContainText("Q1 Full");
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(0);
  expect(await retained()).toEqual(beforeKeyboardInspection);
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
  // Synthetic Chromium touch is software coverage; it does not close either physical-tablet row.
  const cdp = await page.context().newCDPSession(page);
  const touchCell = page.getByTestId(`quarter-cell-${full}-12-0`);
  await touchCell.scrollIntoViewIfNeeded(); const touchBox = (await touchCell.boundingBox())!;
  await viewportEvidence(page, join(shots, `${board}-before-touch-raw`), { full: page.getByTestId(`q1-row-${full}`).locator("th"), tail: page.getByTestId(`q1-row-${tail}`).locator("th") }, false);
  const scrollBefore = await page.getByTestId("q1-grid-scroll").evaluate(el => el.scrollLeft);
  const x = touchBox.x + touchBox.width / 2, y = touchBox.y + 25;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (const delta of [30, 60, 100]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - delta, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => page.getByTestId("q1-grid-scroll").evaluate(el => el.scrollLeft)).toBeGreaterThan(scrollBefore);
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(0);
  await page.getByTestId(`quarter-palette-q1-${board}-b`).click();
  await touchCell.scrollIntoViewIfNeeded();
  const tap = (await touchCell.boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tap.x + 3, y: tap.y + 25 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(1); await save(page); await cdp.detach();
  const names = { full: page.getByTestId(`q1-row-${full}`).locator("th"), tail: page.getByTestId(`q1-row-${tail}`).locator("th") };
  await viewportEvidence(page, join(shots, `${board}-after-touch-save-raw`), names, false);
  // Retain the old capture method separately to distinguish its scroll from normal viewport pixels.
  await page.getByTestId("q1-grid-scroll").screenshot({ path: join(shots, `${board}-saved-quarter-locator-diagnostic.png`) });
  await viewportEvidence(page, join(shots, `${board}-after-locator-raw`), names, false);
  await belowToolbar(page, page.getByTestId("q1-grid-scroll"));
  await viewportEvidence(page, join(shots, `${board}-saved-quarter-viewport`), names);
  for (const fraction of [0, 0.37, 1]) {
    await page.getByTestId("q1-grid-scroll").evaluate((el, f) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) * f; }, fraction);
    await viewportEvidence(page, join(shots, `${board}-saved-quarter-scroll-${fraction}`), names);
  }
  // Read-only visual fixture extends the genuine response with dense colors and saved
  // BREAK/cover spans. It cannot substitute for the real write/receipt assertions above.
  const dense = structuredClone(await day(page, board)), source = dense.sources.find(s => s.shiftId === full)!;
  const at = (time: string) => fromZonedTime(`${date}T${time}:00`, "America/Chicago").toISOString();
  const colors = dense.stations.filter((s, i, all) => all.findIndex(other => other.color === s.color) === i);
  const stationView = (s: typeof colors[number]) => ({ id: s.id, label: s.label, color: s.color, board });
  dense.coverDisplay.tracks = [{ shiftId: full, employeeId: full, firstName: "Q1 Full", lastName: "Synthetic", board, sourcePosition: source.sourcePosition,
    startAt: source.startAt, endAt: source.endAt, segments: [{ startAt: at("11:05"), endAt: at("11:20"), kind: "break", station: stationView(colors[0]), fromStation: null, auto: false }] },
  { shiftId: `q1-${board}-saved-cover`, employeeId: `q1-${board}-saved-cover`, firstName: "Q1 Cover", lastName: "Synthetic", board: "other", sourcePosition: "Office",
    startAt: source.startAt, endAt: source.endAt, segments: [
      { startAt: at("11:05"), endAt: at("11:20"), kind: "cover", station: stationView(colors[0]), fromStation: null, auto: false },
      { startAt: at("11:35"), endAt: at("11:40"), kind: "cover", station: stationView(colors[1]), fromStation: null, auto: false },
    ] }];
  for (const [i, color] of colors.entries()) {
    const id = `q1-${board}-color-${i}`;
    dense.employees.push({ id, firstName: `Color ${color.color}`, lastName: "Synthetic" });
    dense.sources.push({ ...source, shiftId: id, employeeId: id, startAt: at("11:05"), endAt: at("11:55") });
    dense.hours.push({ shiftId: id, hourStart: at("11:00"), revision: null, legacySha256: "0".repeat(64), intervals: [
      { startAt: at("11:00"), endAt: at("11:05"), state: "off", stationId: null, seatNumber: null, provenance: { kind: "legacy", assignmentId: null } },
      { startAt: at("11:05"), endAt: at("11:55"), state: "assigned", stationId: color.id, seatNumber: null, provenance: { kind: "legacy", assignmentId: null } },
      { startAt: at("11:55"), endAt: at("12:00"), state: "off", stationId: null, seatNumber: null, provenance: { kind: "legacy", assignmentId: null } },
    ] });
    dense.coverDisplay.tracks.push({ shiftId: id, employeeId: id, firstName: `Color ${color.color}`, lastName: "Synthetic", board, sourcePosition: source.sourcePosition,
      startAt: source.startAt, endAt: source.endAt, segments: [{ startAt: at("11:05"), endAt: at("11:55"), kind: "work", station: stationView(color), fromStation: null, auto: false }] });
  }
  const longest = { ...colors[0], id: `q1-${board}-longest`, label: "Purple 2 / Jolt", shortCode: "P2", color: "lavender" };
  dense.stations.push(longest);
  dense.coverDisplay.tracks[0].segments.push(...[0, 15, 30, 45].map(minute => ({
    startAt: at(`12:${String(minute).padStart(2, "0")}`), endAt: at(minute === 45 ? "13:00" : `12:${String(minute + 15).padStart(2, "0")}`),
    kind: "work" as const, station: { ...stationView(longest), shortCode: "P2" }, fromStation: null, auto: false,
  })));
  const preservedPaint = async () => db.$transaction(async tx => {
    const result: Record<string, unknown> = {}, quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    for (const [key, table, where, parameters] of [
      ["hours", "PaintHour", " WHERE date=?", [date]],
      ["segments", "PaintSegment", " WHERE paintHourId IN (SELECT id FROM PaintHour WHERE date=?)", [date]],
      ["mutations", "PaintMutation", " WHERE date=?", [date]],
      ["receipts", "PaintCommandReceipt", "", []],
    ] as const) {
      const columns = preservationColumns[table];
      const info = await tx.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${quote(table)})`);
      expect(info.map(column => column.name).sort()).toEqual([...columns].sort());
      // Match the established preservation reader: raw INTEGER decoding narrows
      // epoch milliseconds. Keep every SQL type/value, including exact nulls.
      const fields = columns.flatMap(c => [`typeof(${quote(c)}) AS ${quote(c + ":type")}`, `CAST(${quote(c)} AS TEXT) AS ${quote(c + ":value")}`]);
      const rows = await tx.$queryRawUnsafe<Record<string, string | null>[]>(`SELECT ${fields.join(",")} FROM ${quote(table)}${where}`, ...parameters);
      result[key] = { columns, rows: rows.map(row => columns.map(c => [row[c + ":type"], row[c + ":value"]]))
        .sort((a, b) => Buffer.compare(Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b)))) };
    }
    return result;
  });
  const savedBeforeDisplay = JSON.stringify(await preservedPaint(), (_key, value) => typeof value === "bigint" ? value.toString() : value);
  let visualWrites = 0;
  page.on("request", r => { if (r.method() === "PUT" && r.url().endsWith("/api/v2/assignments/paint")) visualWrites++; });
  await page.route(`**/api/v2/boards/${board}/days/${date}`, route => route.fulfill({ json: dense }));
  await page.getByTestId("refresh-day").click();
  await expect(page.getByTestId(`q1-row-q1-${board}-color-0`)).toBeVisible();
  const coverRow = page.getByTestId(`cover-row-q1-${board}-saved-cover`);
  const coverIdentity = await coverRow.locator('[data-kind="cover"]').evaluateAll(elements => elements.map(el => [el.getAttribute("data-start"), el.getAttribute("data-end")]));
  await page.getByTestId(`quarter-cell-${full}-11-0`).click();
  await expect(page.getByTestId("q1-cell-notice")).toContainText("saved BREAK");
  await page.getByTestId("q1-cell-notice").getByRole("button", { name: "Close", exact: true }).click();
  async function captureMatrix(surfacePage: Page, surface: string) {
    const page = surfacePage, observations = [];
    const coverRow = page.getByTestId(`cover-row-q1-${board}-saved-cover`);
    let mutationRequests = 0;
    const mutations = (r: import("@playwright/test").Request) => { if (r.url().includes("/api/") && ["POST", "PUT", "PATCH", "DELETE"].includes(r.method())) mutationRequests++; };
    page.on("request", mutations);
    for (const locale of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.getByTestId("toolbar-more").click();
      await page.getByTestId(`locale-toggle-${locale}`).click();
      await page.getByTestId("toolbar-more").click();
      await expect(page.getByTestId("floor-board")).toHaveAttribute("data-locale", locale);
      await expect(page.getByTestId("q1-headcount-row")).toContainText(locale === "es" ? "Personal programado" : "Scheduled workers");
      for (const view of ["quarter", "hour"]) {
        if (await page.getByTestId("q1-grid-scroll").getAttribute("data-zoom") !== view) await page.getByTestId("q1-zoom").click();
        await page.getByTestId("q1-hour-header-11").getByRole("button").click();
        const alignment = await page.getByTestId("q1-hour-header-11").boundingBox(), cell = await page.getByTestId(`q1-hour-cell-${full}-11`).boundingBox();
        expect(alignment!.x).toBeCloseTo(cell!.x, 1); expect(alignment!.width).toBeCloseTo(cell!.width, 1);
        const breakWidth = await page.getByTestId(`q1-hour-cell-${full}-11`).locator('[data-kind="break"]').evaluateAll(elements => elements.reduce((n, el) => n + el.getBoundingClientRect().width, 0));
        expect(breakWidth / cell!.width).toBeCloseTo(15 / 60, 2);
        await expect(page.getByTestId(`q1-hour-cell-${full}-11`).locator('[data-kind="break"]').getByTestId("saved-box-time")).toHaveCount(0);
        const cover = await coverRow.locator("td").filter({ has: page.locator('[data-hour="11"]') }).boundingBox();
        expect(cover!.x).toBeCloseTo(cell!.x, 1); expect(cover!.width).toBeCloseTo(cell!.width, 1);
        await expect(page.getByTestId("q1-count-11-0").locator("strong")).toHaveText(String(colors.length + 2));
        const lines = await page.getByTestId(`q1-hour-cell-${full}-11`).evaluate(el => ({ boundary: getComputedStyle(el).borderRightStyle,
          guides: [...el.querySelectorAll('span[aria-hidden="true"]')].map(g => ({ pointer: getComputedStyle(g).pointerEvents, line: getComputedStyle(g.firstElementChild!).borderLeftStyle })) }));
        expect(lines.boundary).toBe("dashed");
        if (view === "quarter") { expect(lines.guides).toHaveLength(1); expect(lines.guides[0]).toEqual({ pointer: "none", line: "dashed" }); }
        const positions = [];
        for (const position of ["center", "initial", "intermediate", "far-edge"] as const) {
          const fraction = { center: null, initial: 0, intermediate: 0.37, "far-edge": 1 }[position];
          if (fraction !== null) await page.getByTestId("q1-grid-scroll").evaluate((el, f) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) * f; }, fraction);
          await belowToolbar(page, page.getByTestId("q1-grid-scroll"));
          const geometry = await page.getByTestId("q1-grid-scroll").evaluate(el => {
            const visible = [...el.querySelectorAll('[data-testid^="q1-hour-header-"]')].filter(h => h.getBoundingClientRect().left >= el.getBoundingClientRect().left + 176 && h.getBoundingClientRect().right <= el.getBoundingClientRect().right);
            return { left: el.scrollLeft, max: el.scrollWidth - el.clientWidth, alignment: visible.map(h => {
              const hour = h.getAttribute("data-testid")!.split("-").at(-1), cell = el.querySelector(`[data-testid$="-full-${hour}"]`)!, a = h.getBoundingClientRect(), b = cell.getBoundingClientRect();
              return { hour, dx: a.x - b.x, dw: a.width - b.width };
            }) };
          });
          expect(geometry.alignment.length).toBeGreaterThan(0);
          for (const { dx, dw } of geometry.alignment) { expect(Math.abs(dx)).toBeLessThan(1); expect(Math.abs(dw)).toBeLessThan(1); }
          if (fraction !== null) expect(geometry.left).toBeCloseTo(geometry.max * fraction, 0);
          const visibleHour = geometry.alignment[0].hour;
          const prefix = join(shots, `${board}-${surface}-${locale}-${theme}-${view}-${position}`);
          const top = await viewportEvidence(page, `${prefix}-top`, {
            header: page.getByTestId(`q1-hour-header-${visibleHour}`), counts: page.getByTestId(`q1-count-${visibleHour}-0`).locator(".."),
            label: page.getByTestId("q1-headcount-row").locator("th").first(), full: page.getByTestId(`q1-row-${full}`).locator("th"), tail: page.getByTestId(`q1-row-${tail}`).locator("th"),
          });
          for (const name of [top.full, top.tail]) { expect(name.position).toBe("sticky"); expect(name.rect.x).toBeCloseTo(name.scroller.x, 0); }
          await belowToolbar(page, coverRow);
          const bottom = await viewportEvidence(page, `${prefix}-cover`, { cover: coverRow.locator("th") });
          expect(bottom.cover.position).toBe("sticky"); expect(bottom.cover.rect.x).toBeCloseTo(bottom.cover.scroller.x, 0);
          expect(bottom.cover.textContent).toContain("Q1 Cover Synthetic");
          expect(bottom.cover.scrollX).toBeCloseTo(geometry.left, 0);
          positions.push({ position, geometry, top, bottom });
        }
        await page.getByTestId("q1-hour-header-11").getByRole("button").click();
        for (let first = 0; first < colors.length; first += 6) {
          const row = page.getByTestId(`q1-row-q1-${board}-color-${first}`);
          await belowToolbar(page, row);
          const targets: Record<string, ReturnType<Page["locator"]>> = {};
          for (let i = first; i < Math.min(first + 6, colors.length); i++) targets[`name-${i}`] = page.getByTestId(`q1-row-q1-${board}-color-${i}`).locator("th");
          await viewportEvidence(page, join(shots, `${board}-${surface}-${locale}-${theme}-${view}-colors-${first}`), targets);
        }
        // Full supplemental facts remain reachable independently of the BACKUP panel.
        const backup = page.getByTestId("auxiliary-toggle");
        if (await backup.getAttribute("aria-expanded") === "true") await backup.click();
        await expect(backup).toHaveAttribute("aria-expanded", "false");
        const coverId = `q1-${board}-saved-cover`, detail = page.getByTestId(`cover-detail-${coverId}`);
        const beforeCounts = await page.getByTestId("q1-headcount-row").textContent();
        const beforeSpans = await coverRow.locator('[data-kind="cover"]').evaluateAll(es => es.map(e => [e.getAttribute("data-start"), e.getAttribute("data-end"), e.getBoundingClientRect().width]));
        // Touch the actual cover hour, including its five-minute fragment.
        await page.getByTestId("q1-hour-header-11").getByRole("button").click();
        await belowToolbar(page, coverRow);
        const touch = await page.context().newCDPSession(page);
        for (const duration of [15, 5]) {
          // Whole-hour headers preserve horizontal scroll. Expose the same
          // cover hour before dispatch so the sticky name cannot receive its tap.
          await page.getByTestId(`cover-hour-detail-${coverId}-11`).evaluate(el => el.scrollIntoView({ block: "nearest", inline: "center" }));
          await belowToolbar(page, coverRow);
          const segment = coverRow.locator('[data-kind="cover"]').nth(duration === 15 ? 0 : 1);
          const target = await segment.evaluate(el => {
            const box = el.getBoundingClientRect(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            const hit = document.elementFromPoint(point.x, point.y);
            return { point, box: { x: box.x, y: box.y, width: box.width, height: box.height },
              hit: hit?.tagName, button: hit?.closest("button")?.getAttribute("data-testid"),
              scrollLeft: el.closest('[data-testid="q1-grid-scroll"]')!.scrollLeft };
          });
          writeFileSync(join(shots, `${board}-${surface}-${locale}-${theme}-${view}-cover-touch-${duration}-target.json`), JSON.stringify(target, null, 2));
          expect(target.button).toBe(`cover-hour-detail-${coverId}-11`);
          await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [target.point] });
          await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await expect(detail).toBeVisible();
          await expect(detail).toContainText("Q1 Cover Synthetic");
          for (const label of ["11:05 AM–11:20 AM", "11:35 AM–11:40 AM", displayStationLabel(locale, colors[0]), displayStationLabel(locale, colors[1])]) await expect(detail).toContainText(label);
          await belowToolbar(page, detail);
          await viewportEvidence(page, join(shots, `${board}-${surface}-${locale}-${theme}-${view}-cover-touch-${duration}`), { detail });
          await detail.getByRole("button", { name: locale === "es" ? "Cerrar" : "Close", exact: true }).click();
          await belowToolbar(page, coverRow);
        }
        await touch.detach();
        // Keyboard focus opens the same detail after a horizontal scroll to the far edge.
        await page.getByTestId("q1-grid-scroll").evaluate(el => { el.scrollLeft = el.scrollWidth - el.clientWidth; });
        const farEdge = await page.getByTestId("q1-grid-scroll").evaluate(el => el.scrollLeft);
        await page.getByTestId(`cover-detail-open-${coverId}`).focus();
        await page.keyboard.press("Enter");
        await expect(detail).toBeVisible(); await belowToolbar(page, detail);
        expect(await page.getByTestId("q1-grid-scroll").evaluate(el => el.scrollLeft)).toBeCloseTo(farEdge, 0);
        await viewportEvidence(page, join(shots, `${board}-${surface}-${locale}-${theme}-${view}-cover-keyboard`), { detail });
        await detail.getByRole("button", { name: locale === "es" ? "Cerrar" : "Close", exact: true }).click();
        expect(await page.getByTestId("q1-headcount-row").textContent()).toBe(beforeCounts);
        expect(await coverRow.locator('[data-kind="cover"]').evaluateAll(es => es.map(e => [e.getAttribute("data-start"), e.getAttribute("data-end"), e.getBoundingClientRect().width]))).toEqual(beforeSpans);
        // After vertical and horizontal scrolling, a local refusal is visible beside its cell.
        if (surface === "editor") {
          await belowToolbar(page, page.getByTestId(`q1-row-${full}`));
          const button = page.getByTestId(`quarter-cell-${full}-11${view === "quarter" ? "-0" : ""}`);
          await button.click();
          await expect(page.getByTestId("q1-cell-notice")).toContainText(view === "quarter" ? "BREAK" : locale === "es" ? "Hora mixta" : "Mixed hour");
          await viewportEvidence(page, join(shots, `${board}-${surface}-${locale}-${theme}-${view}-refusal`), { notice: page.getByTestId("q1-cell-notice") });
          await page.getByTestId("q1-cell-notice").getByRole("button", { name: locale === "es" ? "Cerrar" : "Close", exact: true }).click();
        }
        observations.push({ surface, locale, theme, view, header: alignment, cell, positions, rowHeight: await page.getByTestId(`q1-row-${full}`).evaluate(e => e.getBoundingClientRect().height) });
      }
    }
    page.off("request", mutations); expect(mutationRequests).toBe(0);
    return observations;
  }
  const observations = await captureMatrix(page, "editor");
  // The staff selector deliberately hides timeline today. Add a test-only option to
  // call the existing change handler and mount the real loaded TimelinePanel; this
  // is component visual coverage, not evidence of a public staff navigation route.
  const viewer = await page.context().newPage(); await viewer.setViewportSize({ width: 1280, height: 900 });
  // The synthetic day needs its own date-list fixture; other tests may have
  // seeded no current-day shifts, so the real staff list can correctly be empty.
  await viewer.route("**/api/days", route => route.fulfill({ json: { dates: [date] } }));
  await viewer.route(`**/api/v2/boards/${board}/days/*`, route => {
    expect(new URL(route.request().url()).pathname).toBe(`/api/v2/boards/${board}/days/${date}`);
    return route.fulfill({ json: dense });
  });
  viewer.on("request", r => { if (r.method() === "PUT" && r.url().endsWith("/api/v2/assignments/paint")) visualWrites++; });
  await viewer.goto(`${origin}/?readonly=1&board=${board}`);
  await expect(viewer.getByTestId("compact-view").locator('option[value="timeline"]')).toHaveCount(0);
  await viewer.getByTestId("compact-view").evaluate(el => el.append(new Option("Synthetic timeline fixture", "timeline")));
  await viewer.getByTestId("compact-view").selectOption("timeline");
  await expect(viewer.getByTestId("timeline-panel")).toBeVisible();
  await expect(viewer.getByTestId("compact-date")).toHaveValue(date);
  await expect(viewer.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
  await expect(viewer.getByTestId("q1-headcount-row")).toBeVisible();
  await expect(viewer.getByTestId("quarter-hour-editor")).toHaveCount(0);
  observations.push(...await captureMatrix(viewer, "timeline"));
  const previewDir = join(process.env.FLOOR_BOARDS_TEST_ROOT!, "painter-go-screens"); mkdirSync(previewDir, { recursive: true });
  const previewEvidence = [];
  // Tablet-size screenshots of the actual loaded components with a labelled,
  // read-only synthetic day. Browser media emulation is not an OS setting change.
  for (const [surface, target] of [["painter", page], ["staff-hora", viewer]] as const) {
    await target.setViewportSize({ width: 1024, height: 768 });
    await target.getByTestId("toolbar-more").click(); await target.getByTestId("locale-toggle-en").click(); await target.getByTestId("toolbar-more").click();
    if (await target.getByTestId("q1-grid-scroll").getAttribute("data-zoom") !== "hour") await target.getByTestId("q1-zoom").click();
    for (const theme of ["light", "dark"] as const) {
      await target.emulateMedia({ colorScheme: theme });
      await target.getByTestId("q1-hour-header-12").getByRole("button").click();
      await target.getByTestId("q1-grid-scroll").evaluate(el => { el.scrollLeft = 300; });
      await belowToolbar(target, target.getByTestId("q1-grid-scroll"));
      const merged = target.getByTestId(`q1-hour-cell-${full}-12`);
      await expect(merged.locator("[data-kind]")).toHaveCount(1);
      await expect(merged.getByTestId("saved-box-label")).toHaveText("Purple 2 / Jolt");
      await expect(merged.getByTestId("saved-box-time")).toHaveCount(0);
      await expect(target.getByTestId("q1-grid").locator("thead tr")).toHaveCount(1);
      const geometry = await merged.evaluate(el => {
        const band = el.querySelector('[data-kind]')!, row = el.closest("tr")!, name = row.querySelector("th")!;
        const box = (node: Element) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
        return { band: box(band), cell: box(el), row: box(row), name: box(name), gridBackground: getComputedStyle(el.closest("table")!).backgroundColor };
      });
      expect(geometry.cell.width).toBeCloseTo(100, 0);
      expect(geometry.row.height).toBe(geometry.name.height);
      expect(Math.abs(geometry.band.top - geometry.cell.top)).toBeLessThan(2);
      expect(Math.abs(geometry.band.bottom - geometry.cell.bottom)).toBeLessThan(2);
      expect(geometry.gridBackground).toBe("rgb(255, 255, 255)");
      await viewportEvidence(target, join(previewDir, `${board}-${surface}-${theme}`), { label: merged.getByTestId("saved-box-label"), header: target.getByTestId("q1-hour-header-12") });
      previewEvidence.push({ surface, theme, themeSource: "browser-media-emulation", viewport: target.viewportSize(), geometry });
    }
  }
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.getByTestId("compact-view").selectOption("board");
    const occupants = page.getByTestId(`station-${longest.id}`).getByTestId("saved-station-occupants");
    await expect(occupants).toContainText("Q1 Full Synthetic");
    await expect(occupants).not.toContainText("12:00"); await expect(page.getByTestId("station-interval")).toHaveCount(0);
    await page.getByTestId(`station-${longest.id}`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(previewDir, `${board}-puesto-${theme}.png`) });
  }
  const wall = await page.context().newPage(); await wall.setViewportSize({ width: 1024, height: 768 });
  await wall.clock.install({ time: new Date(at("12:30")) });
  await wall.route(`**/api/v2/boards/${board}/days/*`, route => route.fulfill({ json: dense }));
  await wall.goto(`${origin}/?wall=1&board=${board}`);
  for (const theme of ["light", "dark"] as const) {
    await wall.emulateMedia({ colorScheme: theme });
    const occupants = wall.getByTestId(`wall-who-${longest.id}`);
    await expect(occupants).toContainText("Q1 Full Synthetic"); await expect(occupants).not.toContainText("12:00");
    await expect(wall.getByTestId("station-interval")).toHaveCount(0);
    await wall.getByTestId(`wall-station-${longest.id}`).scrollIntoViewIfNeeded();
    await wall.screenshot({ path: join(previewDir, `${board}-wall-${theme}.png`) });
    await expect(wall.getByTestId("saved-cover-panel")).toBeVisible();
    await expect(wall.getByTestId("saved-cover-panel")).toContainText("12:00 PM–12:15 PM");
  }
  await wall.close();
  const savedAfterDisplay = JSON.stringify(await preservedPaint(), (_key, value) => typeof value === "bigint" ? value.toString() : value);
  expect(savedAfterDisplay).toBe(savedBeforeDisplay);
  writeFileSync(join(previewDir, `${board}-evidence.json`), JSON.stringify({ fixture: "synthetic day response; actual built UI", themeSource: "browser-media-emulation", staffHora: "existing component mounted through test-only selector option", previewEvidence, savedBeforeDisplay: JSON.parse(savedBeforeDisplay), savedAfterDisplay: JSON.parse(savedAfterDisplay) }, null, 2));
  await viewer.close();
  expect(visualWrites).toBe(0);
  expect(await coverRow.locator('[data-kind="cover"]').evaluateAll(elements => elements.map(el => [el.getAttribute("data-start"), el.getAttribute("data-end")]))).toEqual(coverIdentity);
  writeFileSync(join(shots, `${board}-geometry.json`), JSON.stringify({ overview, expanded, height, observations }, null, 2));
});
