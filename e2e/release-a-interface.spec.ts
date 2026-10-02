import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const output = () => { const dir = join(process.env.FLOOR_BOARDS_TEST_ROOT!, "release-a-screens"); mkdirSync(dir, { recursive: true }); return dir; };
async function capture(page: Page, name: string, evidence: unknown) {
  await page.screenshot({ path: join(output(), `${name}.png`), fullPage: false });
  writeFileSync(join(output(), `${name}.json`), JSON.stringify({ url: page.url(), evidence }, null, 2));
}
async function unlock(page: Page, code = "e2e-second-owner") {
  await page.getByTestId("manager-code-input").fill(code); await page.getByTestId("manager-unlock-submit").click();
}

for (const locale of ["es", "en"] as const) for (const theme of ["light", "dark"] as const) test(`${locale}/${theme}: Inicio destinations, return links and independent sign-in`, async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(l => localStorage.setItem("taco-oasis-locale-v1", l), locale);
  await page.goto("/inicio?board=caja");
  const home = page.getByTestId("inicio"); await expect(home).toBeVisible();
  await expect(page.getByTestId("inicio-admin")).toContainText(locale === "es" ? "Acceso de gerente" : "Manager sign-in");
  expect(await home.locator('a[href="/receipts"]').count()).toBe(0);
  const links = await home.locator('nav[aria-label="Destinos"] a, nav[aria-label="Destinations"] a').evaluateAll(nodes => nodes.map(n => n.getAttribute("href")));
  expect(links).toHaveLength(6); expect(links.join(" ")).not.toMatch(/token|session|code=/i);
  await capture(page, `inicio-${locale}-${theme}`, links);
  for (const id of ["next", "break", "now", "admin", "wall", "floor"]) {
    await page.getByTestId(`inicio-${id}`).click();
    if (id === "admin") await expect(page.getByTestId("back-office-code")).toBeVisible();
    if (id === "floor") await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "staff");
    if (id === "wall") await expect(page.getByTestId("wall-exit")).toBeVisible();
    await expect(page.getByTestId("inicio-link")).toBeVisible();
    await page.getByTestId("inicio-link").click(); await expect(home).toBeVisible();
  }
  expect((await request.get("/api/admin/managers")).status()).toBe(401);
  expect((await request.post("/api/receipts", { data: {} })).status()).toBe(401);
  await page.getByTestId("inicio-floor").click(); await page.getByTestId("compact-manager").click(); await unlock(page);
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role", "manager");
  await page.getByTestId("inicio-link").click(); await page.getByTestId("inicio-admin").click();
  await expect(page.getByTestId("back-office-code")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("taco-oasis-back-office-session"))).toBeNull();
});

for (const board of ["caja", "cocina"]) test(`${board}: Hide/Show stays top right in narrow, folded and scrolled views`, async ({ page }) => {
  await page.goto(`/?board=${board}`);
  const records = [];
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const folded of [false, true]) {
      if (folded) await page.getByTestId("toolbar-hide").click();
      const control = page.getByTestId(folded ? "toolbar-show" : "toolbar-hide");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await expect(control).toBeInViewport({ ratio: 1 });
      const rect = await control.boundingBox(); expect(rect!.y).toBeLessThan(20); expect(rect!.x + rect!.width).toBeGreaterThan(width - 25);
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      records.push({ width, folded, rect }); await capture(page, `controls-${board}-${width}-${folded}`, records.at(-1));
      if (folded) await control.click();
    }
  }
});

async function orders(page: Page) {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "fixtures/square-next/orders.json"), "utf8"));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  await page.route("**/api/upcoming", route => route.fulfill({ json: { source: "fixture", orders: fixture.orders.map((o: object) => ({ ...o, event_date: today })), heldBack: 0, fetchedAt: new Date().toISOString(), stale: false, today } }));
}
for (const mode of ["off", "history", "network"] as const) test(`NEXT actual print mount stays hidden: ${mode}`, async ({ page }) => {
  await orders(page); let reads = 0, writes = 0;
  await page.route("**/api/upcoming/print**", async route => {
    if (route.request().method() === "POST") { writes++; await route.abort(); return; }
    reads++; if (mode === "network") await route.abort();
    else await route.fulfill({ status: mode === "history" ? 503 : 200, json: mode === "history" ? { printing: true, history_available: false, error: "history_unavailable" } : { printing: false } });
  });
  await page.goto("/next"); await page.getByTestId("next-card-hj35YY").click();
  await expect.poll(() => reads).toBe(1); await expect(page.getByTestId("t4g-print-button")).toHaveCount(0);
  await expect(page.getByTestId("receipt-workspace")).toHaveCount(0); expect(writes).toBe(0);
  await capture(page, `print-hidden-${mode}`, { reads, writes });
});

for (const locale of ["es", "en"] as const) test(`${locale}: mounted PrintButton unlock, repeated taps, expiry and per-order uncertainty use synthetic HTTP only`, async ({ page }) => {
  await orders(page); let writes = 0; let mode: "expired" | "uncertain" = "expired"; let authorized = false;
  await page.route("**/api/upcoming/print**", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { printing: true, printed: false, locked_until: null } });
    writes++; authorized = Boolean(route.request().headers()["x-manager-session"]);
    await route.fulfill({ status: mode === "expired" ? 401 : 200, json: { status: "uncertain", cambio: false, problems: [] } });
  });
  await page.goto("/next"); if (locale === "en") await page.getByTestId("next-locale").click();
  expect(await page.locator('a[href="/receipts"]').count()).toBe(0);
  await page.getByTestId("next-card-hj35YY").click(); await expect(page.getByTestId("t4g-print-button")).toBeVisible();
  await page.getByTestId("t4g-print-button").evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await expect(page.getByTestId("manager-unlock-modal")).toBeVisible(); expect(writes).toBe(0);
  await unlock(page); await expect(page.getByTestId("t4g-print-notice")).toHaveAttribute("data-kind", "managerOnly"); expect(writes).toBe(1); expect(authorized).toBe(true);
  mode = "uncertain"; await page.getByTestId("t4g-print-button").click(); await expect(page.getByTestId("manager-unlock-modal")).toBeVisible(); await unlock(page);
  await expect(page.getByTestId("t4g-print-notice")).toHaveAttribute("data-kind", "uncertain"); await expect(page.getByTestId("t4g-print-button")).toHaveCount(0); expect(writes).toBe(2);
  await page.getByTestId("next-detail-close").click(); await page.getByTestId("next-card-AgIeZY").click(); await expect(page.getByTestId("t4g-print-button")).toBeVisible();
  await page.getByTestId("next-detail-close").click(); await page.getByTestId("next-card-hj35YY").click();
  await expect(page.getByTestId("t4g-print-notice")).toHaveAttribute("data-kind", "uncertain"); await expect(page.getByTestId("t4g-print-button")).toHaveCount(0); expect(writes).toBe(2);
  await capture(page, `print-uncertain-${locale}`, { writes, authorized, transport: "Playwright route fixture; no server print POST" });
});
