import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import closed from "../fixtures/receipts/closed-batch-examples-v1.json";

const bundleRequire = createRequire(process.cwd() + "/package.json");
const { buildSync } = createRequire(bundleRequire.resolve("tsx/package.json"))("esbuild") as {
  buildSync(options: { entryPoints: string[]; bundle: boolean; write: boolean; platform: string; jsx: string; define: Record<string, string> }): { outputFiles: { text: string }[] };
};
async function open(page: Page, locale: string, query: string, direct = false) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date("2026-10-01T04:00:00.000Z") });
  const bundle = buildSync({ entryPoints: ["e2e/fixtures/" + (direct ? "receipts-offline" : "receipts-projection") + ".tsx"], bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }).outputFiles[0].text;
  const dir = path.join(process.cwd(), ".next/static/css");
  const css = readdirSync(dir).filter((p) => p.endsWith(".css")).map((p) => readFileSync(path.join(dir, p), "utf8")).join("\n");
  await page.route("http://projection-fixture.invalid/**", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="root"></div>' }));
  await page.goto("http://projection-fixture.invalid/?locale=" + locale + "&" + query);
  await page.addScriptTag({ content: bundle });
  await expect(page.getByTestId("receipt-workspace")).toBeVisible();
  const out = path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "receipts-projection-screens");
  mkdirSync(out, { recursive: true });
  return { out, capture: (name: string) => page.screenshot({ path: path.join(out, locale + "_" + name + ".png"), fullPage: true }) };
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { receiptFakeCalls: { op: string; request_id: string; args: { original_request_id?: string } }[] }).receiptFakeCalls);

for (const locale of ["es", "en"] as const) test(locale + ": recovered outcome follows owner proof while recorded rows stay unchanged", async ({ page }) => {
  const h = await open(page, locale, "case=U09");
  const recover = page.getByRole("button", { name: locale === "es" ? "Revisar este intento" : "Review this attempt", exact: true });
  expect(await calls(page)).toEqual([]);
  let originalRows: string[] | null = null;
  for (const [turn, name] of ["pending", "unconfirmed", "regained"].entries()) {
    await recover.click();
    await expect(page.getByRole("alert")).toContainText(turn === 1 ? locale === "es" ? "El estado actual no está confirmado" : "The current state is unconfirmed" : locale === "es" ? "Envío en curso" : "Send in progress");
    const rows = page.getByTestId("receipt-history-row");
    await expect(rows).toHaveCount(2);
    expect(await rows.locator("button,select,input").count()).toBe(0);
    const text = await rows.allTextContents();
    if (originalRows) expect(text).toEqual(originalRows); else originalRows = text;
    for (const row of await rows.all()) await expect(row).toContainText(locale === "es" ? "Último estado registrado" : "Last recorded state");
    expect(await rows.locator("time").evaluateAll((xs) => xs.map((x) => x.getAttribute("datetime")))).toEqual(["2000-01-01T00:00:02.000Z", "2000-01-01T00:00:01.000Z"]);
    await h.capture(name);
    await page.clock.fastForward(30000);
    expect((await calls(page)).length).toBe(turn + 1);
  }
  await recover.click();
  await expect(page.getByRole("alert")).toContainText(locale === "es" ? "Puede haber salido papel" : "Paper may have printed");
  await expect(page.getByTestId("receipt-workspace")).not.toContainText(locale === "es" ? "Envío en curso" : "Send in progress");
  expect(await page.getByTestId("receipt-history-row").allTextContents()).toEqual(originalRows);
  await h.capture("failed_read");
  const commands = await calls(page);
  expect(commands).toHaveLength(4);
  expect(commands.every((c) => c.op === "recover")).toBe(true);
  expect(new Set(commands.map((c) => c.args.original_request_id)).size).toBe(1);
  writeFileSync(path.join(h.out, locale + "_recovery-calls.json"), JSON.stringify({ commands, retainedRows: originalRows }, null, 2));
});

for (const locale of ["es", "en"] as const) test(locale + ": retained observations and unavailable history remain distinct", async ({ page }) => {
  const h = await open(page, locale, "case=U08");
  await page.getByRole("button", { name: locale === "es" ? "Revisar este intento" : "Review this attempt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(locale === "es" ? "El estado actual no está confirmado" : "The current state is unconfirmed");
  const rows = page.getByTestId("receipt-history-row");
  await expect(rows.first()).toContainText(locale === "es" ? "Salió completo y legible" : "Complete and legible");
  expect(await rows.locator("button,select,input").count()).toBe(0);
  await h.capture("retained_observation");
  expect((await calls(page)).map((c) => c.op)).toEqual(["recover"]);
  // Navigation deliberately creates a different synthetic history scenario.
  await page.goto("http://projection-fixture.invalid/?locale=" + locale + "&case=U13");
  const bundle = buildSync({ entryPoints: ["e2e/fixtures/receipts-projection.tsx"], bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: locale === "es" ? "Revisar este intento" : "Review this attempt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(locale === "es" ? "No se pudo leer el registro" : "Could not read the record");
  await expect(page.getByTestId("receipt-history-row")).toHaveCount(2);
  expect(await page.getByTestId("receipt-history-row").locator("button,select,input").count()).toBe(0);
  await h.capture("history_unavailable");
  expect((await calls(page)).map((c) => c.op)).toEqual(["recover"]);
});

for (const locale of ["es", "en"] as const) test(locale + ": direct pending submit retains only original-ID recovery", async ({ page }) => {
  const h = await open(page, locale, "unfinished=pending", true);
  await page.getByRole("button", { name: locale === "es" ? "Cargar destinos actuales" : "Load current destinations", exact: true }).click();
  for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.check();
  await page.getByRole("button", { name: locale === "es" ? "Usar destinos predeterminados" : "Use default destinations", exact: true }).click();
  await page.getByRole("button", { name: locale === "es" ? "Revisar boletos y destinos" : "Review tickets and destinations", exact: true }).click();
  await page.getByRole("button", { name: locale === "es" ? "Imprimir 2 boletos" : "Print 2 tickets", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(locale === "es" ? "Envío en curso" : "Send in progress");
  expect(await page.getByTestId("receipt-history-row").locator("button,select,input").count()).toBe(0);
  await expect(page.getByRole("button", { name: locale === "es" ? "Revisar este intento" : "Review this attempt", exact: true })).toBeEnabled();
  await h.capture("direct_pending");
  await page.clock.fastForward(30000);
  expect((await calls(page)).map((c) => c.op)).toEqual(["read_defaults", "prepare", "submit"]);
});


for (const locale of ["es", "en"] as const) for (const order of [[1, 2], [2, 1]]) test(locale + ": closed and successor sends stay separate in order " + order.join("-"), async ({ page }) => {
  const h = await open(page, locale, "closed=1");
  await page.getByText(locale === "es" ? "Intentos recientes" : "Recent attempts", { exact: true }).click();
  expect(await calls(page)).toEqual([]);
  for (const n of order) {
    await page.getByRole("button", { name: (locale === "es" ? "Revisar registro " : "Review record ") + n, exact: true }).click();
    if (n === 1 && order[0] === 1) {
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("receipt-journal-v1:projection-manager")!).pending.request_id)).toBe(closed.examples.identities.submit_b2);
    }
  }
  const groups = page.getByTestId("receipt-history-group");
  await expect(groups).toHaveCount(2);
  const b1 = groups.filter({ hasText: locale === "es" ? "No se intentó enviar en este envío" : "No send was attempted in this send" });
  const b2 = groups.filter({ hasText: locale === "es" ? "Enviado · papel por revisar" : "Sent · check paper" });
  await expect(b1).toHaveCount(1); await expect(b2).toHaveCount(1);
  const prior = await b1.textContent();
  expect(await b1.locator("button,select,input").count()).toBe(0);
  expect(await b1.locator("time").getAttribute("datetime")).toBe("2000-01-01T00:00:02.000Z");
  expect(await b2.locator("time").getAttribute("datetime")).toBe("2000-01-01T00:00:06.000Z");
  await h.capture("closed_" + order.join("_"));
  await b2.getByRole("button", { name: locale === "es" ? "Salió completo y legible" : "Complete and legible", exact: true }).click();
  expect(await b1.textContent()).toBe(prior);
  expect(await b2.locator("time").getAttribute("datetime")).toBe("2000-01-01T00:00:07.000Z");
  await expect(b2.locator("p").filter({ hasText: locale === "es" ? "Salió completo y legible" : "Complete and legible" })).toHaveCount(1);
  await h.capture("closed_" + order.join("_") + "_observed");
  await page.clock.fastForward(30000);
  const commands = await calls(page);
  expect(commands.map((c) => c.op)).toEqual(["recover", "recover", "observe"]);
  expect(commands[2].args).toEqual({ attempt_id: closed.examples.identities.attempt, observation: "accepted", evidence_handle: null });
  writeFileSync(path.join(h.out, locale + "_closed_" + order.join("_") + "_calls.json"), JSON.stringify({ commands, preservedClosedText: prior }, null, 2));
});
