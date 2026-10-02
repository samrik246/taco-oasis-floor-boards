import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fromZonedTime } from "date-fns-tz";
import { safeDatabasePath } from "../scripts/test-db-path.cjs";
import { belowToolbar } from "./fixtures/q1-visibility";

const date = "2044-10-12", origin = "http://floor-boards.test:3100";
const ids = ["nieves-empty", "nieves-partial", "nieves-reassigned", "nieves-split", "nieves-kitchen"];
let db: PrismaClient;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const url = `file:${join(process.env.FLOOR_BOARDS_TEST_ROOT!, "e2e.db")}`;
  safeDatabasePath({ ...process.env, DATABASE_URL: url }); db = new PrismaClient({ datasources: { db: { url } } });
  for (const id of ids.filter(id => id !== "nieves-split")) await db.employee.create({ data: { id, externalId: id, firstName: id, lastName: "Synthetic" } });
  const at = (time: string) => fromZonedTime(`${date}T${time}:00`, "America/Chicago");
  for (const id of ids) await db.shift.create({ data: { id, employeeId: id === "nieves-split" ? "nieves-partial" : id,
    date, board: id === "nieves-kitchen" ? "cocina" : "caja",
    sourcePosition: id === "nieves-split" ? "Caja - Regular" : id === "nieves-kitchen" ? "Cocina - Guia Abrir" : "Caja - Nieves",
    startAt: at(id === "nieves-split" ? "15:00" : "11:00"), endAt: at(id === "nieves-split" ? "16:00" : "14:00") } });
  for (const [id, stationId] of [["nieves-partial", "nieves"], ["nieves-reassigned", "green1"]]) await db.assignment.create({ data: { id: `${id}-saved`, shiftId: id, employeeId: id, stationId, hourStart: at("11:00"), hourEnd: at("12:00"), seatNumber: stationId === "nieves" ? 1 : null } });
});
test.afterAll(async () => {
  await db.$executeRawUnsafe("UPDATE QuarterSchema SET phase='prepared',minReader=1,minWriter=1,activatedAtMs=NULL WHERE id=1");
  await db.assignment.deleteMany({ where: { shiftId: { in: ids } } });
  await db.shift.deleteMany({ where: { id: { in: ids } } });
  await db.employee.deleteMany({ where: { id: { in: ids } } }); await db.$disconnect();
});
async function open(page: Page, board: string) {
  await page.goto(`${origin}/?board=${board}`);
  await page.getByTestId("compact-manager").click(); await page.getByTestId("manager-code-input").fill("e2e-second-owner");
  await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
  await page.getByTestId("compact-date").selectOption(date); await page.getByTestId("compact-view").selectOption("timeline");
}
async function legacyToolbar(page: Page, shots: string, name: string, id: string) {
  const matrix = page.getByTestId("paint-matrix"), label = page.getByTestId(`source-role-${id}`);
  const records = [];
  for (const side of ["left", "right"]) {
    await belowToolbar(page, label.locator(".."));
    const box = await matrix.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, Math.max(box!.y, 150) + 100);
    await page.mouse.wheel(side === "right" ? 1800 : -1800, 0);
    await expect.poll(() => matrix.evaluate(el => el.scrollLeft)).toBe(side === "left" ? 0 : await matrix.evaluate(el => el.scrollWidth - el.clientWidth));
    const proof = await page.getByTestId("compact-toolbar").evaluate(el => {
      const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
      const controls = [...el.querySelectorAll("button,select")].filter(e => e.getBoundingClientRect().width > 0).map(e => {
        const r = rect(e);
        return { id: e.getAttribute("data-testid"), rect: r, points: [0.1, 0.5, 0.9].map(f => {
          const top = document.elementFromPoint(r.x + (r.right - r.x) * f, (r.y + r.bottom) / 2);
          return { unobscured: Boolean(top && e.contains(top)), top: top?.tagName };
        }) };
      });
      const header = document.querySelector('[data-testid="paint-matrix"] th[scope="col"]')!;
      return { controls, toolbar: rect(el), tableHeader: rect(header), scrollY,
        scrollX: document.querySelector('[data-testid="paint-matrix"]')!.scrollLeft };
    });
    expect(proof.controls.length).toBeGreaterThan(3);
    expect(proof.controls.every(c => c.points.every(p => p.unobscured))).toBe(true);
    // Retain the failing geometry: the legacy header crosses the toolbar.
    expect(proof.tableHeader.y).toBeLessThan(proof.toolbar.bottom);
    const sticky = await label.evaluate(el => {
      const r = el.getBoundingClientRect(), m = el.closest('[data-testid="paint-matrix"]')!.getBoundingClientRect();
      return { x: r.x, right: r.right, matrixX: m.x, hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
    });
    expect(sticky.x).toBeGreaterThanOrEqual(sticky.matrixX); expect(sticky.hit).toBe(true);
    await page.screenshot({ path: join(shots, `${name}-${side}-toolbar.png`), fullPage: false });
    // Pointer focus and native option selection change the loaded date; More
    // separately proves keyboard activation at this toolbar.
    const dateControl = page.getByTestId("compact-date");
    await dateControl.click(); await page.keyboard.press("Escape"); await expect(dateControl).toBeFocused();
    const options = await dateControl.locator("option").evaluateAll(els => els.map(e => (e as HTMLOptionElement).value));
    const index = options.indexOf(date), step = index > 0 ? -1 : 1;
    expect(options.length).toBeGreaterThan(1);
    await dateControl.selectOption(options[index + step]);
    await expect(dateControl).toHaveValue(options[index + step]);
    await dateControl.selectOption(date);
    await expect(dateControl).toHaveValue(date); await expect(label).toBeVisible();
    await page.getByTestId("toolbar-more").focus(); await page.keyboard.press("Enter");
    await expect(page.getByTestId("locale-toggle-en")).toBeVisible();
    await page.getByTestId("toolbar-more").press("Enter");
    await expect(page.getByTestId("locale-toggle-en")).toHaveCount(0);
    records.push({ side, ...proof, sticky, dateInteraction: { from: date, to: options[index + step], returned: date }, moreInteraction: "keyboard-enter" });
  }
  writeFileSync(join(shots, `${name}-toolbar.json`), JSON.stringify(records, null, 2));
  await matrix.evaluate(el => { el.scrollLeft = 0; });
}
for (const phase of ["prepared", "active"]) test(`${phase}: source roles remain visible for blank, partial, reassigned and split shifts in the working grid`, async ({ page }) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1280, height: 900 });
  if (phase === "active") await db.$executeRawUnsafe("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=1 WHERE id=1");
  const before = await db.assignment.findMany({ where: { shiftId: { in: ids } }, orderBy: { id: "asc" } });
  const shots = join(process.env.FLOOR_BOARDS_TEST_ROOT!, "nieves-screens"); mkdirSync(shots, { recursive: true });
  for (const board of ["caja", "cocina"]) {
    await open(page, board);
    await expect(page.getByTestId(phase === "active" ? "q1-grid" : "paint-matrix")).toBeVisible();
    for (const locale of ["en", "es"]) for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.getByTestId("toolbar-more").click(); await page.getByTestId(`locale-toggle-${locale}`).click(); await page.getByTestId("toolbar-more").click();
      if (phase === "prepared") await legacyToolbar(page, shots, `${phase}-${board}-${locale}-${theme}`, board === "caja" ? "nieves-empty" : "nieves-kitchen");
      for (const id of board === "caja" ? ids.filter(id => id !== "nieves-kitchen") : ["nieves-kitchen"]) {
        const label = page.getByTestId(`source-role-${id}`);
        await expect(label).toContainText(id === "nieves-split" ? "Caja - Regular" : board === "cocina" ? "Cocina - Guia Abrir" : "Caja - Nieves");
        await belowToolbar(page, label.locator(".."));
        const proof = await label.evaluate(el => {
          const r = el.getBoundingClientRect(), header = document.querySelector("header")!.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { text: el.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom,
            visible: r.y >= header.bottom && r.bottom <= innerHeight && r.x >= 0 && r.right <= innerWidth,
            unobscured: Boolean(hit && el.contains(hit)) };
        });
        expect(proof.visible).toBe(true); expect(proof.unobscured).toBe(true);
        const name = `${phase}-${board}-${locale}-${theme}-${id}`;
        await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });
        writeFileSync(join(shots, `${name}.json`), JSON.stringify(proof, null, 2));
      }
      if (board === "caja") {
        const missing = page.getByTestId("nieves-unassigned"); await expect(missing).toContainText("nieves-empty Synthetic · 11:00 AM–2:00 PM");
        await expect(missing).toContainText("nieves-partial Synthetic · 12:00 PM–2:00 PM");
        await expect(missing).toContainText("nieves-reassigned Synthetic · 12:00 PM–2:00 PM");
        await expect(missing).not.toContainText("3:00 PM");
        await belowToolbar(page, missing); await page.screenshot({ path: join(shots, `${phase}-${locale}-${theme}-unassigned.png`) });
      }
    }
  }
  expect(await db.assignment.findMany({ where: { shiftId: { in: ids } }, orderBy: { id: "asc" } })).toEqual(before);
  expect(Number((await db.$queryRawUnsafe<{ n: number }[]>("SELECT COUNT(*) n FROM PaintHour WHERE date=?", date))[0].n)).toBe(0);
});
