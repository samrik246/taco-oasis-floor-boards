/**
 * The check-only dialog mode against a fake scheduler in headless Chromium.
 * The fake dialog is the live capture's shape; its date buttons report every
 * click, so a check that opens a picker is caught.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Route } from "@playwright/test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { playwrightExporter } from "@/lib/wiw-export/browser";
import { runCheckDialog } from "@/lib/wiw-export/check-dialog";
import { WiwLogin } from "@/lib/wiw-export/login-file";
import { PROBE_EXIT } from "@/lib/wiw-export/probe";
import { STOP_EXIT } from "@/lib/wiw-export/run";
import { chicagoDateTime } from "@/lib/time";

const ORIGIN = "https://wiw.test";
/** Monday 3 Jun 2030: this week 31 May..6 Jun. */
const NOW = chicagoDateTime("2030-06-03", "6:15 am");
const PERSON = "Brenda Sentinelperson";

type Fake = {
  dates?: [string, string];
  noDialog?: boolean;
  /** The close button does nothing and Escape does nothing. */
  stuckOpen?: boolean;
  mfa?: boolean;
};

type Seen = { exports: number; picker: number; print: number; clear: number };

const scheduler = (fake: Fake) => {
  const [start, end] = fake.dates ?? ["05/31/2030", "06/06/2030"];
  const closeJs = fake.stuckOpen ? "" : "document.getElementById('dlg').hidden=true";
  return `<h1>Scheduler</h1>
<button>${PERSON} 9a-5p</button>
<button aria-label="More Actions" onclick="document.getElementById('menu').hidden=false">&#8942;</button>
<div id="menu" role="menu" hidden>
  <div role="menuitem" tabindex="0" onclick="fetch('/print')">Print Schedule</div>
  <div role="menuitem" tabindex="0" onclick="${fake.noDialog ? "" : "document.getElementById('dlg').hidden=false"}">Export Schedule</div>
  <div role="menuitem" tabindex="0" onclick="fetch('/clear')">Clear Schedule</div>
</div>
<div id="dlg" role="dialog" aria-label="Export Schedule" hidden>
  <button aria-label="close" onclick="${closeJs}">&times;</button>
  <button aria-label="Start Date" onclick="fetch('/datepicker')">${start}</button><button onclick="fetch('/datepicker')">&#128197;</button>
  <button aria-label="End Date" onclick="fetch('/datepicker')">${end}</button><button onclick="fetch('/datepicker')">&#128197;</button>
  <div role="checkbox" tabindex="0" aria-checked="true">Split into separate schedules</div>
  <button onclick="location.href='/download'">Export</button>
</div>
${fake.stuckOpen ? "" : "<script>document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('dlg').hidden = true; });</script>"}`;
};

const MFA = `<h1>Enter the code</h1><label>Verification code <input name="verification_code" autocomplete="one-time-code"></label>`;
const html = (body: string) => ({ status: 200, contentType: "text/html", body: `<!doctype html><html><body>${body}</body></html>` });

async function serve(context: BrowserContext, fake: Fake, seen: Seen) {
  await context.route(`${ORIGIN}/**`, async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/print") return route.fulfill({ status: 204 }).then(() => void (seen.print += 1));
    if (p === "/clear") return route.fulfill({ status: 204 }).then(() => void (seen.clear += 1));
    if (p === "/datepicker") return route.fulfill({ status: 204 }).then(() => void (seen.picker += 1));
    if (p === "/download") {
      seen.exports += 1;
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="x.xlsx"' },
        body: "FAKE",
      });
    }
    if (fake.mfa) return route.fulfill(html(MFA));
    return route.fulfill(html(scheduler(fake)));
  });
}

let browser: Browser;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  dir = await mkdtemp(path.join(tmpdir(), "b2-check-"));
});

afterAll(async () => {
  await browser?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function check(fake: Fake) {
  const seen: Seen = { exports: 0, picker: 0, print: 0, clear: 0 };
  const appDir = await mkdtemp(path.join(dir, "app-"));
  const importDir = await mkdtemp(path.join(dir, "import-"));
  const settings = {
    appDir,
    importDir,
    loginFile: "/unused/wiw-login",
    profileDir: "/unused",
    logFile: path.join(appDir, "var", "log", "wiw-export.log"),
    importMode: "apply" as const,
  };
  const result = await runCheckDialog(settings, {
    now: () => NOW,
    readLogin: async () => new WiwLogin("x@example.invalid", "y"),
    actionTimeoutMs: 1_000,
    exporter: (hook) =>
      playwrightExporter({
        profileDir: "/unused",
        schedulerUrl: `${ORIGIN}/scheduler`,
        stepTimeoutMs: 2_000,
        menuSettleMs: 50,
        dialogRetryMs: 300,
        probe: hook,
        launch: async () => {
          const context = await browser.newContext({ acceptDownloads: false });
          await serve(context, fake, seen);
          return context;
        },
      }),
  });
  const log = await readFile(settings.logFile, "utf8");
  const files = (await readdir(appDir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  return { result, seen, log, importDir, files };
}

describe("B2 check-dialog (fake scheduler)", { timeout: 30_000 }, () => {
  it("this week: reads the dates, closes, exit 6; no date button, picker or Export click", async () => {
    const res = await check({});
    expect(res.result.exitCode).toBe(PROBE_EXIT);
    expect(res.log).toContain("check-dialog start this=2030-05-31..2030-06-06");
    expect(res.log).toContain("step=dialog.read");
    expect(res.log).toContain("step=close");
    expect(res.log).toContain("dialog start=05/31/2030 end=06/06/2030");
    expect(res.log).toContain("week=this");
    expect(res.log).toContain("export_clicked=no downloads=0");
    expect(res.log).toContain(`end exit=${PROBE_EXIT}`);
    expect(res.log).not.toContain("step_error");
    expect(res.seen).toEqual({ exports: 0, picker: 0, print: 0, clear: 0 });
    expect(await readdir(res.importDir)).toEqual([]);
    expect(res.files).toEqual(["wiw-export.log"]);
    expect(res.log).not.toContain(PERSON);
  });

  it("next week or another week: week=next / week=other, exit 5 WEEK", async () => {
    const next = await check({ dates: ["06/07/2030", "06/13/2030"] });
    expect(next.log).toContain("week=next");
    expect(next.log).toContain("stop=PAGE reason=WEEK");
    expect(next.result.exitCode).toBe(STOP_EXIT);

    const other = await check({ dates: ["06/07/2030", "06/06/2030"] });
    expect(other.log).toContain("week=other");
    expect(other.result.exitCode).toBe(STOP_EXIT);
    expect(other.seen.picker).toBe(0);
  });

  it("the dialog never opens: step_error=dialog.open, week=failed, exit 5 DIALOG_OPEN", async () => {
    const res = await check({ noDialog: true });
    expect(res.log).toContain("step_error=dialog.open");
    expect(res.log).toContain("week=failed");
    expect(res.log).toContain("stop=PAGE reason=DIALOG_OPEN");
    expect(res.result.exitCode).toBe(STOP_EXIT);
  });

  it("a dialog that will not close: the close step logs class and call only; the read still counts", async () => {
    const res = await check({ stuckOpen: true });
    expect(res.log).toMatch(/step_error=close error=TimeoutError call=locator\.waitFor/);
    expect(res.log).not.toMatch(/Timeout \d+ms|waiting for/);
    expect(res.log).toContain("week=this");
    expect(res.seen.picker).toBe(0);
  });

  it("a code screen before the menu: exit 5 MFA, no dialog read", async () => {
    const res = await check({ mfa: true });
    expect(res.log).toContain("stop=MFA");
    expect(res.log).toContain("week=failed");
    expect(res.result.exitCode).toBe(STOP_EXIT);
  });
});
