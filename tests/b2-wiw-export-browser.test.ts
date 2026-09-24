/**
 * The B2 browser steps against a fake scheduler in headless Chromium. The fake
 * dialog is rebuilt from the live capture of 24 Sep 2026 (probe on T MAC
 * MINI): dialog "Export Schedule", date buttons showing MM/dd/yyyy, four
 * comboboxes, the Split checkbox and Export. The fake names its download from
 * the dates the buttons show. No real When I Work page is opened.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Route } from "@playwright/test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { playwrightExporter } from "@/lib/wiw-export/browser";
import { WiwLogin } from "@/lib/wiw-export/login-file";
import { runProbeDialog, PROBE_EXIT } from "@/lib/wiw-export/probe";
import { ExportStop, STOP_EXIT } from "@/lib/wiw-export/run";
import { dialogDate, expectedDownloadName } from "@/lib/wiw-export/week";

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
  /** Export Schedule opens nothing. */
  noDialog?: boolean;
  /** Export Schedule clicks lost to the menu fade before one opens the dialog. */
  swallowClicks?: number;
  /** The dialog opens on the week before. */
  datesOffByWeek?: boolean;
  /** Hidden inputs behind the date pickers that carry the same labels. */
  hiddenDateInputs?: boolean;
};

type Seen = {
  print: number;
  clear: number;
  exports: number;
  /** Export Schedule clicks. */
  menuClicks: number;
  /** Date button clicks: the job never opens a date picker. */
  datePicker: number;
  posts: Array<{ email: string; password: string }>;
};

const seenNone = (): Seen => ({ print: 0, clear: 0, exports: 0, menuClicks: 0, datePicker: 0, posts: [] });

const LOGIN = `<form method="post" action="/login">
  <label>Email <input type="email" name="email"></label>
  <label>Password <input type="password" name="password"></label>
  <button type="submit">Log In</button></form>`;

/** A person's name that a probe log must never carry. */
const PERSON = "Brenda Sentinelperson";
/** The date the Start button shows: a value, so never in the log. */
const SHOWN_START = dialogDate(WEEK.friday);
/** A combobox value: never in the log. */
const COMBO_VALUE = "Combo-sentinel-4r";

const combobox = (name: string) =>
  `<button>Remove All</button><input role="combobox" aria-label="${name}" aria-expanded="false" value="${COMBO_VALUE}">`;

const scheduler = (fake: Fake) => {
  const [start, end] = fake.datesOffByWeek ? ["05/24/2030", "05/30/2030"] : [SHOWN_START, dialogDate(WEEK.thursday)];
  const open = fake.noDialog
    ? ""
    : `if (++window.clicks > ${fake.swallowClicks ?? 0}) document.getElementById('dlg').hidden=false`;
  return `<h1>Scheduler</h1>
<script>window.clicks = 0;</script>
<button>${PERSON} 9a-5p</button>
<button aria-label="More Actions" onclick="document.getElementById('menu').hidden=false">&#8942;</button>
<div id="menu" role="menu" hidden>
  <div role="menuitem" tabindex="0" onclick="fetch('/print')">Print Schedule</div>
  <div role="menuitem" tabindex="0" onclick="fetch('/export-item'); ${open}">Export Schedule</div>
  <div role="menuitem" tabindex="0" onclick="fetch('/clear')">Clear Schedule</div>
</div>
<div id="dlg" role="dialog" aria-label="Export Schedule" hidden>
  <button aria-label="close">&times;</button>
  <button id="s" aria-label="Start Date" onclick="fetch('/datepicker')">${start}</button><button onclick="fetch('/datepicker')">&#128197;</button>
  <button id="e" aria-label="End Date" onclick="fetch('/datepicker')">${end}</button><button onclick="fetch('/datepicker')">&#128197;</button>
  ${fake.hiddenDateInputs ? `<input aria-label="Start Date" hidden><input aria-label="End Date" hidden>` : ""}
  ${combobox("Schedules")}${combobox("Job Sites")}${combobox("Positions")}${combobox("Users")}
  <div role="checkbox" tabindex="0" aria-checked="${fake.splitUnchecked ? "false" : "true"}">Split into separate schedules</div>
  <button onclick="location.href='/download?s='+encodeURIComponent(s.textContent)+'&e='+encodeURIComponent(e.textContent)">Export</button>
</div>`;
};

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
    if (p === "/export-item") return route.fulfill({ status: 204 }).then(() => void (seen.menuClicks += 1));
    if (p === "/datepicker") return route.fulfill({ status: 204 }).then(() => void (seen.datePicker += 1));
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
  const seen = seenNone();
  const readLogin = vi.fn(async () => new WiwLogin(SECRET_EMAIL, SECRET_PASSWORD));
  const exporter = playwrightExporter({
    profileDir: "/unused",
    schedulerUrl: `${ORIGIN}/scheduler`,
    stepTimeoutMs: opts.stepTimeoutMs ?? 5_000,
    downloadTimeoutMs: 5_000,
    menuSettleMs: 50,
    dialogRetryMs: 300,
    launch: async () => {
      const context = await browser.newContext({ acceptDownloads: true });
      await serve(context, fake, seen);
      return context;
    },
  });
  let error: unknown = null;
  let saved: string | null = null;
  let name: string | null = null;
  const notes: string[] = [];
  try {
    const dl = await exporter.exportWeek(WEEK, readLogin, async (line) => void notes.push(line));
    name = dl.suggestedName;
    saved = path.join(dir, `${Date.now()}-${Math.random()}.xlsx`);
    await dl.saveAs(saved);
    await dl.discard();
  } catch (err) {
    error = err;
  } finally {
    await exporter.close();
  }
  return { seen, readLogin, error, saved, name, notes };
}

const stopOf = (e: unknown) => (e instanceof ExportStop ? `${e.code}${e.reason ? `/${e.reason}` : ""}` : String(e));

describe("B2 browser steps (fake scheduler)", { timeout: 30_000 }, () => {
  it("signed in: More Actions, Export Schedule only, this Friday to Thursday, one export", async () => {
    const res = await attempt({ signedIn: true });
    expect(res.error).toBeNull();
    expect(res.name).toBe(expectedDownloadName(WEEK));
    expect(await readFile(res.saved!, "utf8")).toBe("FAKE-XLSX");
    expect(res.seen).toMatchObject({ print: 0, clear: 0, exports: 1, menuClicks: 1, datePicker: 0 });
    expect(res.readLogin).not.toHaveBeenCalled();
    expect(res.notes).toEqual([]);
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
    const seen = seenNone();
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
    const seen = seenNone();
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

  it("menu fade: a swallowed Export Schedule click is clicked once more, logged, then exports", async () => {
    const res = await attempt({ signedIn: true, swallowClicks: 1 });
    expect(res.error).toBeNull();
    expect(res.name).toBe(expectedDownloadName(WEEK));
    expect(res.seen).toMatchObject({ print: 0, clear: 0, exports: 1, menuClicks: 2, datePicker: 0 });
    expect(res.notes).toEqual(["menu retry=1"]);
  });

  it("PAGE: no dialog after the one retry stops DIALOG_OPEN, two clicks only", async () => {
    const res = await attempt({ signedIn: true, noDialog: true }, { stepTimeoutMs: 1_000 });
    expect(stopOf(res.error)).toBe("PAGE/DIALOG_OPEN");
    expect(res.seen).toMatchObject({ print: 0, clear: 0, exports: 0, menuClicks: 2 });
    expect(res.notes).toEqual(["menu retry=1"]);
  });

  it("PAGE: the dialog on another week stops DIALOG_DATE; the date pickers are never opened", async () => {
    const res = await attempt({ signedIn: true, datesOffByWeek: true });
    expect(stopOf(res.error)).toBe("PAGE/DIALOG_DATE");
    expect(res.seen).toMatchObject({ exports: 0, datePicker: 0 });
  });

  it("hidden inputs carrying the date labels do not count", async () => {
    const res = await attempt({ signedIn: true, hiddenDateInputs: true });
    expect(res.error).toBeNull();
    expect(res.seen.exports).toBe(1);
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

describe("B2 probe-dialog mode (fake scheduler)", { timeout: 30_000 }, () => {
  async function probe(fake: Fake) {
    const seen = seenNone();
    const appDir = await mkdtemp(path.join(dir, "app-"));
    const importDir = await mkdtemp(path.join(dir, "import-"));
    const settings = {
      appDir,
      importDir,
      loginFile: "/unused/wiw-login",
      profileDir: "/unused",
      logFile: path.join(appDir, "var", "log", "wiw-export.log"),
      importMode: "hold" as const,
    };
    let downloads = 0;
    const result = await runProbeDialog(settings, {
      readLogin: async () => new WiwLogin(SECRET_EMAIL, SECRET_PASSWORD),
      exporter: (hook) =>
        playwrightExporter({
          profileDir: "/unused",
          schedulerUrl: `${ORIGIN}/scheduler`,
          stepTimeoutMs: 2_000,
          menuSettleMs: 50,
          dialogRetryMs: 300,
          probe: hook,
          launch: async () => {
            const context = await browser.newContext({ acceptDownloads: true });
            await serve(context, fake, seen);
            context.on("page", (p) => p.on("download", () => void (downloads += 1)));
            for (const p of context.pages()) p.on("download", () => void (downloads += 1));
            return context;
          },
        }),
    });
    const log = await readFile(settings.logFile, "utf8");
    return { result, seen, downloads, log, appDir, importDir };
  }

  /** Every file under a folder, relative. */
  async function tree(root: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) out.push(path.relative(root, path.join(e.parentPath, e.name)));
    }
    return out.sort();
  }

  it("dialog: captures it, never clicks Export, saves nothing, writes no timer", async () => {
    const res = await probe({});
    expect(res.result.exitCode).toBe(PROBE_EXIT);
    // Signed in from the file, then stopped at the dialog: no Export click, no download, no Print/Clear.
    expect(res.seen.posts).toHaveLength(1);
    expect(res.seen).toMatchObject({ print: 0, clear: 0, exports: 0 });
    expect(res.downloads).toBe(0);
    expect(await readdir(res.importDir)).toEqual([]);
    // Only the log and the snapshot: no var/run plist, nothing else.
    const files = await tree(res.appDir);
    expect(files).toHaveLength(2);
    expect(files[0]).toBe(path.join("var", "log", "wiw-export.log"));
    expect(files[1]).toMatch(/^var\/log\/wiw-probe-.+\.aria\.yml$/);
  });

  it("dialog: the snapshot is mode 600 and holds the values; the log holds none", async () => {
    const res = await probe({});
    const file = res.result.snapshotFile!;
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const snap = await readFile(file, "utf8");
    expect(snap).toContain(SHOWN_START);
    expect(snap).toContain('button "Start Date"');

    expect(res.log).toContain(
      "probe export_dialog=1 dialogs=1 scope=export_dialog start_button=1 end_button=1 split_checkbox=1 export_button=1",
    );
    expect(res.log).toContain('probe control role=button name="Start Date"');
    expect(res.log).toContain('probe control role=button name="End Date"');
    expect(res.log).toContain('probe control role=checkbox name="Split into separate schedules" state=[checked]');
    expect(res.log).toContain('probe control role=button name="Export"');
    expect(res.log).toContain('probe control role=combobox name="Schedules"');
    expect(res.log).toContain(`probe end exit=${PROBE_EXIT}`);
    expect(res.log).not.toContain("menu retry");
    for (const secret of [SHOWN_START, PERSON, "Brenda", SECRET_EMAIL, SECRET_PASSWORD, COMBO_VALUE]) {
      expect(res.log).not.toContain(secret);
    }
  });

  it("no dialog: captures the page; names only export-shaped controls, counts the rest", async () => {
    const res = await probe({ signedIn: true, noDialog: true });
    expect(res.result.exitCode).toBe(PROBE_EXIT);
    expect(res.seen.exports).toBe(0);
    expect(res.log).toContain("probe menu retry=1");
    expect(res.log).toContain(
      "probe export_dialog=0 dialogs=0 scope=page start_button=0 end_button=0 split_checkbox=0 export_button=0",
    );
    expect(res.log).toMatch(/probe control other=[1-9]/);
    expect(res.log).not.toContain("Brenda");
    expect((await stat(res.result.snapshotFile!)).mode & 0o777).toBe(0o600);
    expect(await readFile(res.result.snapshotFile!, "utf8")).toContain(PERSON);
  });

  it("a stop before the menu exits 5 with no snapshot", async () => {
    const res = await probe({ mfa: true });
    expect(res.result.exitCode).toBe(STOP_EXIT);
    expect(res.result.snapshotFile).toBeNull();
    expect(res.log).toContain("probe stop=MFA");
    expect(await tree(res.appDir)).toEqual([path.join("var", "log", "wiw-export.log")]);
  });
});
