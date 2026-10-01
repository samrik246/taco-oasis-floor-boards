import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
// Use the bundler pinned by the existing tsx tool; no production dependency.
const bundleRequire = createRequire(process.cwd() + "/package.json");
const { buildSync } = createRequire(bundleRequire.resolve("tsx/package.json"))("esbuild") as {
  buildSync(options: { entryPoints: string[]; bundle: boolean; write: boolean; platform: string; jsx: string; define: Record<string, string> }): { outputFiles: { text: string }[] };
};
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

for (const locale of ["es", "en"] as const) test(`${locale}: synthetic receipt picker, immutable review and partial history`, async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date("2026-10-01T04:00:00.000Z") });
  const bundle = buildSync({ entryPoints: ["e2e/fixtures/receipts-offline.tsx"], bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }).outputFiles[0].text;
  const dir = path.join(process.cwd(), ".next/static/css");
  const css = readdirSync(dir).filter((p) => p.endsWith(".css")).map((p) => readFileSync(path.join(dir, p), "utf8")).join("\n");
  let requests = 0;
  await page.route("http://receipts-fixture.invalid/**", async (route) => {
    requests++;
    await route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div id="root"></div></body></html>' });
  });
  await page.goto(`http://receipts-fixture.invalid/?locale=${locale}`); await page.addScriptTag({ content: bundle });
  const workspace = page.getByTestId("receipt-workspace"); await expect(workspace).toBeVisible();
  const calls = () => page.evaluate(() => (window as unknown as { receiptFakeCalls: { op: string; args: unknown }[] }).receiptFakeCalls);
  expect(await calls()).toEqual([]);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  const out = path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "receipts-offline-screens"); mkdirSync(out, { recursive: true });
  const capture = (state: string) => page.screenshot({ path: path.join(out, `${locale}_${state}.png`), fullPage: true });
  await capture("diagnostics");
  await page.getByRole("button", { name: locale === "es" ? "Cargar destinos actuales" : "Load current destinations", exact: true }).click();
  for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.check();
  await page.getByRole("button", { name: locale === "es" ? "Usar destinos predeterminados" : "Use default destinations", exact: true }).click();
  await capture("picker");
  await page.getByRole("button", { name: locale === "es" ? "Revisar boletos y destinos" : "Review tickets and destinations", exact: true }).click();
  await expect(page.locator("pre").first()).toContainText("2.04 lb TEST ITEM");
  expect((await calls()).map((c) => c.op)).toEqual(["read_defaults", "prepare"]);
  await capture("review");
  await page.getByRole("button", { name: locale === "es" ? "Imprimir 2 boletos" : "Print 2 tickets", exact: true }).click();
  await expect(workspace).toContainText(locale === "es" ? "Resultado sin confirmar" : "Result unconfirmed");
  await expect(workspace).toContainText(locale === "es" ? "Enviado · papel por revisar" : "Sent · check paper");
  await capture("partial");
  expect((await calls()).map((c) => c.op)).toEqual(["read_defaults", "prepare", "submit"]);
  expect(requests).toBe(1);
  writeFileSync(path.join(out, `${locale}_calls.json`), JSON.stringify({ syntheticOnly: true, calls: await calls(), networkRequests: requests }, null, 2));
});

test("real production route requires manager and remains unavailable without an installed engine", async ({ page, request }) => {
  const body = { schema: "receipt-browser/v1", request_id: "a".repeat(32), op: "status_cached", args: { device_id: "receipt-169" } };
  expect((await request.post("/api/receipts", { data: body })).status()).toBe(401);
  const login = await request.post("/api/managers", { data: { code: "8642" } });
  const auth = await login.json();
  const res = await request.post("/api/receipts", { data: body, headers: { "x-manager-session": auth.sessionToken } });
  expect(res.status()).toBe(503); expect(await res.json()).toMatchObject({ state: "unavailable", reason: "runtime_unavailable", data: null });
  let calls = 0; page.on("request", (req) => { if (req.url().includes("/api/receipts")) calls++; });
  await page.route("**/api/managers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const result = await route.fetch(); await route.fulfill({ response: result, json: { ...await result.json(), idleMs: 120000 } });
  });
  await page.goto("/receipts");
  await expect(page.getByText("Se necesita acceso de gerente")).toBeVisible();
  await page.getByRole("button", { name: "Iniciar sesión de gerente" }).click();
  await page.getByTestId("manager-code-input").fill("8642"); await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("receipt-workspace")).toBeVisible(); expect(calls).toBe(0);
  await page.getByRole("button", { name: "Ver registro", exact: true }).first().click();
  await expect(page.getByRole("alert")).toContainText("No se pudo completar la consulta"); expect(calls).toBe(1);
});

for (const locale of ["es", "en"] as const) test(`${locale}: RP1 paper faults remain visible through failed busy throttled and expired status`, async ({ page }) => {
  page.setDefaultTimeout(15000); await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date("2026-10-01T04:00:00.000Z") });
  const bundle = buildSync({ entryPoints: ["e2e/fixtures/receipts-offline.tsx"], bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }).outputFiles[0].text;
  const dir = path.join(process.cwd(), ".next/static/css");
  const css = readdirSync(dir).filter((p) => p.endsWith(".css")).map((p) => readFileSync(path.join(dir, p), "utf8")).join("\n");
  await page.route("http://receipts-fixture.invalid/**", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="root"></div>' }));
  const out = path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "receipts-offline-screens"); mkdirSync(out, { recursive: true });
  const records = [];
  for (const phase of ["failed", "busy", "throttled", "expired"]) {
    await page.goto(`http://receipts-fixture.invalid/?locale=${locale}&phase=${phase}`); await page.addScriptTag({ content: bundle });
    const card = page.getByRole("heading", { name: "receipt-fx-a", exact: true }).locator("..");
    await card.getByRole("button", { name: locale === "es" ? "Ver registro" : "View saved status", exact: true }).click();
    const previous = card.getByRole("complementary", { name: locale === "es" ? "Último estado conocido" : "Last known status", exact: true });
    if (phase === "failed") await card.screenshot({ path: path.join(out, `${locale}_RP1_fresh.png`) });
    if (phase === "expired") await page.clock.fastForward(61000);
    else await card.getByRole("button", { name: locale === "es" ? "Consultar estado" : "Check status", exact: true }).click();
    await expect(previous).toContainText(locale === "es" ? "Sin papel" : "Out of paper");
    await expect(previous).toContainText(locale === "es" ? "Tapa abierta" : "Cover open");
    await expect(previous).toContainText(locale === "es" ? "Revisar papel" : "Check paper");
    expect(await previous.locator("time").evaluateAll((els) => els.map((el) => el.getAttribute("datetime")))).toEqual(["2026-10-01T04:00:00.000Z", "2026-10-01T04:01:00.000Z"]);
    const expected: Record<string, string> = locale === "es" ? { failed: "Sin respuesta", busy: "No se consultó · otra operación en curso", throttled: "No se consultó · espera un momento", expired: "Estado anterior · consultar de nuevo" } : { failed: "No response", busy: "Not checked · another operation is active", throttled: "Not checked · wait a moment", expired: "Previous status · check again" };
    await expect(card.locator(":scope > p").first()).toHaveText(expected[phase]);
    await card.screenshot({ path: path.join(out, `${locale}_RP1_${phase}.png`) });
    const calls = await page.evaluate(() => (window as unknown as { receiptFakeCalls: { op: string }[] }).receiptFakeCalls);
    expect(calls.map((c) => c.op)).toEqual(phase === "expired" ? ["status_cached"] : ["status_cached", "status_refresh"]);
    records.push({ phase, calls });
  }
  writeFileSync(path.join(out, `${locale}_RP1_calls.json`), JSON.stringify({ syntheticOnly: true, records }, null, 2));
});
