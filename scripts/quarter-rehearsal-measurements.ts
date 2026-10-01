/** Two real loaded browser profiles; public measurements only, no session material retained. */
import { chromium, expect, type BrowserContext } from "@playwright/test";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
const [out] = process.argv.slice(2), root = realpathSync(process.env.FLOOR_BOARDS_TEST_ROOT!);
if (!/^\/private\/tmp\/color-boards-test-[A-Za-z0-9]+$/.test(root) || !realpathSync(out).startsWith(root + path.sep)) throw new Error("SYNTHETIC_MEASUREMENT_ROOT_REQUIRED");
const origin = "http://floor-boards.test:3100";
async function main() {
  const contexts: BrowserContext[] = [];
  try {
    for (const name of ["floor", "wall"]) contexts.push(await chromium.launchPersistentContext(path.join(out, name + "-profile"), { headless: true, args: ["--host-resolver-rules=MAP floor-boards.test 127.0.0.1", "--no-proxy-server"] }));
    const pages = await Promise.all(contexts.map(c => c.newPage())), devices = [];
    for (let i = 0; i < pages.length; i++) {
      await pages[i].addInitScript(() => localStorage.setItem("taco-oasis-locale-v1", "en"));
      await pages[i].goto(`${origin}/?board=caja&readback=1${i ? "&wall=1" : ""}`);
      const id = pages[i].getByTestId("client-instance-id"); await expect(id).toHaveText(/^[a-f0-9-]{36}$/);
      devices.push({ label: `synthetic-${i}`, role: i ? "wall" : "floor", origin, clientInstanceId: await id.textContent(), board: "caja", view: i ? "wall" : "schedule", disposition: "retained" });
    }
    expect(devices[0].clientInstanceId).not.toBe(devices[1].clientInstanceId);
    const owner = await pages[0].evaluate(async () => {
      const response = await fetch("/api/managers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "quarter-rehearsal-owner" }) });
      if (!response.ok) throw new Error("SYNTHETIC_OWNER_LOGIN_FAILED");
      return (await response.json()).manager.id as string;
    });
    const inventory = { version: 1, synthetic: true, revision: "synthetic-real-two-profile-rehearsal", operatorId: owner, enumeratedAt: new Date().toISOString(), devices }, receipts = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i], panel = page.getByTestId("quarter-client-readback");
      await panel.locator('input[type="file"]').setInputFiles({ name: "inventory.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(inventory)) });
      await panel.getByLabel("Device label").fill(devices[i].label); await panel.locator('input[type="checkbox"]').check();
      await panel.getByRole("button", { name: "Owner sign in" }).click();
      await page.getByTestId("manager-code-input").fill("quarter-rehearsal-owner"); await page.getByTestId("manager-unlock-submit").click();
      const issue = page.waitForResponse(r => r.url().endsWith("/api/v2/maintenance/clients") && r.request().postDataJSON().action === "issue");
      const answer = page.waitForResponse(r => r.url().endsWith("/api/v2/maintenance/clients") && r.request().postDataJSON().action === "answer");
      await panel.getByRole("button", { name: "Record readback" }).click();
      expect((await issue).status()).toBe(200); const response = await answer; expect(response.status()).toBe(200);
      const receipt = await response.json();
      expect(receipt).toMatchObject({ synthetic: true, matched: true, label: devices[i].label, measurement: { clientInstanceId: devices[i].clientInstanceId, isSecureContext: false, idbProbe: "commit-readback-ok", legacyBoardCacheAbsent: true, protocol: 2, cacheSchema: 2, draftDbVersion: 1 } });
      receipts.push(receipt);
      const status = await page.evaluate(async body => {
        const login = await fetch("/api/managers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "quarter-rehearsal-owner" }) }), session = await login.json();
        return (await fetch("/api/v2/maintenance/clients", { method: "POST", headers: { "Content-Type": "application/json", "x-manager-session": session.sessionToken }, body: JSON.stringify(body) })).status;
      }, response.request().postDataJSON());
      expect(status).toBe(409);
    }
    writeFileSync(path.join(out, "inventory.json"), JSON.stringify(inventory) + "\n");
    writeFileSync(path.join(out, "readbacks.json"), JSON.stringify(receipts) + "\n");
  } finally { await Promise.all(contexts.map(c => c.close())); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
