/**
 * The B2 browser steps against a fake scheduler in headless Chromium. The fake
 * names its download from the dates typed into the dialog, so a wrong date
 * shows up as a wrong file name. No real When I Work page is opened.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Route } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { playwrightExporter } from "@/lib/wiw-export/browser";
import { WiwLogin } from "@/lib/wiw-export/login-file";
import { ExportStop } from "@/lib/wiw-export/run";
import { expectedDownloadName } from "@/lib/wiw-export/week";

const ORIGIN = "https://wiw.test";
const WEEK = { friday: "2030-05-31", thursday: "2030-06-06" };
const SECRET_EMAIL = "sentinel-login-7q2x@example.invalid";
const SECRET_PASSWORD = "Sentinel-Pass-9Zk!w";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Fake = {
  signedIn?: boolean;
  /** The sign-in page answers with a code screen. */
  mfaAfterSignIn?: boolean;
  mfa?: boolean;
  captcha?: boolean;
  unknown?: boolean;
  splitUnchecked?: boolean;
  /** Where Sign in lands before the scheduler. */
  landing?: "dashboard";
};

type Seen = { print: number; clear: number; exports: number; posts: Array<{ email: string; password: string }> };

const LOGIN = `<form method="post" action="/login">
  <label>Email <input type="email" name="email"></label>
  <label>Password <input type="password" name="password"></label>
  <button type="submit">Log In</button></form>`;

const scheduler = (fake: Fake) => `<h1>Scheduler</h1>
<button aria-label="More Actions" onclick="document.getElementById('menu').hidden=false">&#8942;</button>
<div id="menu" role="menu" hidden>
  <div role="menuitem" tabindex="0" onclick="fetch('/print')">Print Schedule</div>
  <div role="menuitem" tabindex="0" onclick="document.getElementById('dlg').hidden=false">Export Schedule</div>
  <div role="menuitem" tabindex="0" onclick="fetch('/clear')">Clear Schedule</div>
</div>
<div id="dlg" role="dialog" aria-label="Export Schedule" hidden>
  <label>Start Date <input id="s" value="01/01/2000"></label>
  <label>End Date <input id="e" value="01/01/2000"></label>
  <label>Schedules <select><option>All</option></select></label>
  <label><input type="checkbox" id="split" ${fake.splitUnchecked ? "" : "checked"}> Split into separate schedules</label>
  <button onclick="location.href='/download?s='+encodeURIComponent(s.value)+'&e='+encodeURIComponent(e.value)">Export</button>
</div>`;

const MFA = `<h1>Enter the code</h1><label>Verification code <input name="verification_code" autocomplete="one-time-code"></label>`;
const CAPTCHA = `<h1>Check</h1><iframe title="captcha" src="about:blank"></iframe>`;

function label(mmddyyyy: string): string {
  const [m, d, y] = mmddyyyy.split("/").map(Number);
  return `${MONTHS[m! - 1]} ${d}, ${y}`;
}

const html = (body: string) => ({ status: 200, contentType: "text/html", body: `<!doctype html><html><body>${body}</body></html>` });

async function serve(context: BrowserContext, fake: Fake, seen: Seen) {
  let signedIn = !!fake.signedIn;
  await context.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/print") return route.fulfill({ status: 204 }).then(() => void (seen.print += 1));
    if (p === "/clear") return route.fulfill({ status: 204 }).then(() => void (seen.clear += 1));
    if (p === "/login" && route.request().method() === "POST") {
      const form = new URLSearchParams(route.request().postData() ?? "");
      const post = { email: form.get("email") ?? "", password: form.get("password") ?? "" };
      seen.posts.push(post);
      if (post.email === SECRET_EMAIL && post.password === SECRET_PASSWORD) {
        if (fake.mfaAfterSignIn) return route.fulfill(html(MFA));
        signedIn = true;
        return route.fulfill({ status: 302, headers: { location: fake.landing === "dashboard" ? "/dashboard" : "/scheduler" } });
      }
      return route.fulfill(html(`<p>Wrong password</p>${LOGIN}`));
    }
    if (p === "/dashboard") return route.fulfill(html("<h1>Dashboard</h1>"));
    if (p === "/download") {
      seen.exports += 1;
      const name = `Schedule for ${label(url.searchParams.get("s")!)} - ${label(url.searchParams.get("e")!)}.xlsx`;
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="${name}"`,
        },
        body: "FAKE-XLSX",
      });
    }
    if (fake.unknown) return route.fulfill(html("<h1>We have updated our look</h1>"));
    if (fake.captcha) return route.fulfill(html(CAPTCHA));
    if (fake.mfa) return route.fulfill(html(MFA));
    return route.fulfill(html(signedIn ? scheduler(fake) : LOGIN));
  });
}

let browser: Browser;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  dir = await mkdtemp(path.join(tmpdir(), "b2-wiw-browser-"));
});

afterAll(async () => {
  await browser?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function attempt(fake: Fake, opts: { stepTimeoutMs?: number } = {}) {
  const seen: Seen = { print: 0, clear: 0, exports: 0, posts: [] };
  const readLogin = vi.fn(async () => new WiwLogin(SECRET_EMAIL, SECRET_PASSWORD));
  const exporter = playwrightExporter({
    profileDir: "/unused",
    schedulerUrl: `${ORIGIN}/scheduler`,
    stepTimeoutMs: opts.stepTimeoutMs ?? 5_000,
    downloadTimeoutMs: 5_000,
    menuSettleMs: 50,
    launch: async () => {
      const context = await browser.newContext({ acceptDownloads: true });
      await serve(context, fake, seen);
      return context;
    },
  });
  let error: unknown = null;
  let saved: string | null = null;
  let name: string | null = null;
  try {
    const dl = await exporter.exportWeek(WEEK, readLogin);
    name = dl.suggestedName;
    saved = path.join(dir, `${Date.now()}-${Math.random()}.xlsx`);
    await dl.saveAs(saved);
    await dl.discard();
  } catch (err) {
    error = err;
  } finally {
    await exporter.close();
  }
  return { seen, readLogin, error, saved, name };
}

const stopOf = (e: unknown) => (e instanceof ExportStop ? `${e.code}${e.reason ? `/${e.reason}` : ""}` : String(e));

describe("B2 browser steps (fake scheduler)", { timeout: 30_000 }, () => {
  it("signed in: More Actions, Export Schedule only, this Friday to Thursday, one export", async () => {
    const res = await attempt({ signedIn: true });
    expect(res.error).toBeNull();
    expect(res.name).toBe(expectedDownloadName(WEEK));
    expect(await readFile(res.saved!, "utf8")).toBe("FAKE-XLSX");
    expect(res.seen).toMatchObject({ print: 0, clear: 0, exports: 1 });
    expect(res.readLogin).not.toHaveBeenCalled();
  });

  it("sign-in page: types the two fields once, clicks Sign in, then exports", async () => {
    const res = await attempt({});
    expect(res.error).toBeNull();
    expect(res.readLogin).toHaveBeenCalledTimes(1);
    expect(res.seen.posts).toEqual([{ email: SECRET_EMAIL, password: SECRET_PASSWORD }]);
    expect(res.name).toBe(expectedDownloadName(WEEK));
  });

  it("sign-in that lands on another page opens the scheduler again", async () => {
    const res = await attempt({ landing: "dashboard" });
    expect(res.error).toBeNull();
    expect(res.seen.exports).toBe(1);
  });

  it("LOGIN: a rejected sign-in stops after one try", async () => {
    const readLogin = async () => new WiwLogin(SECRET_EMAIL, "wrong");
    const seen: Seen = { print: 0, clear: 0, exports: 0, posts: [] };
    const exporter = playwrightExporter({
      profileDir: "/unused",
      schedulerUrl: `${ORIGIN}/scheduler`,
      stepTimeoutMs: 2_000,
      launch: async () => {
        const context = await browser.newContext({ acceptDownloads: true });
        await serve(context, {}, seen);
        return context;
      },
    });
    let error: unknown;
    try {
      await exporter.exportWeek(WEEK, readLogin);
    } catch (err) {
      error = err;
    } finally {
      await exporter.close();
    }
    expect(stopOf(error)).toBe("LOGIN/REJECTED");
    expect(seen.posts).toHaveLength(1);
    expect(seen.exports).toBe(0);
  });

  it("LOGIN: a login file that cannot be read stops before anything is typed", async () => {
    const seen: Seen = { print: 0, clear: 0, exports: 0, posts: [] };
    const exporter = playwrightExporter({
      profileDir: "/unused",
      schedulerUrl: `${ORIGIN}/scheduler`,
      stepTimeoutMs: 2_000,
      launch: async () => {
        const context = await browser.newContext();
        await serve(context, {}, seen);
        return context;
      },
    });
    const error = await exporter
      .exportWeek(WEEK, async () => {
        throw new ExportStop("LOGIN", "MODE");
      })
      .catch((e: unknown) => e);
    await exporter.close();
    expect(stopOf(error)).toBe("LOGIN/MODE");
    expect(seen.posts).toHaveLength(0);
  });

  it("MFA: a code screen stops, before or after sign-in", async () => {
    expect(stopOf((await attempt({ mfa: true })).error)).toBe("MFA");
    const after = await attempt({ mfaAfterSignIn: true });
    expect(stopOf(after.error)).toBe("MFA");
    expect(after.seen.exports).toBe(0);
  });

  it("CAPTCHA: a challenge frame stops", async () => {
    const res = await attempt({ captcha: true });
    expect(stopOf(res.error)).toBe("CAPTCHA");
    expect(res.readLogin).not.toHaveBeenCalled();
  });

  it("PAGE: a screen the steps do not know stops", async () => {
    const res = await attempt({ unknown: true }, { stepTimeoutMs: 1_000 });
    expect(stopOf(res.error)).toBe("PAGE/UNKNOWN_SCREEN");
    expect(res.seen).toMatchObject({ print: 0, clear: 0, exports: 0 });
  });

  it("PAGE: Split into separate schedules unchecked stops without exporting", async () => {
    const res = await attempt({ signedIn: true, splitUnchecked: true });
    expect(stopOf(res.error)).toBe("PAGE/DIALOG_SPLIT");
    expect(res.seen.exports).toBe(0);
  });

  it("PAGE: no browser session", async () => {
    const exporter = playwrightExporter({
      profileDir: "/unused",
      launch: async () => {
        throw new Error("no display");
      },
    });
    const error = await exporter.exportWeek(WEEK, async () => new WiwLogin("a", "b")).catch((e: unknown) => e);
    await exporter.close();
    expect(stopOf(error)).toBe("PAGE/BROWSER");
  });
});
