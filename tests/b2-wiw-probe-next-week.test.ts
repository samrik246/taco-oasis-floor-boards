/**
 * The next-week probe against a fake scheduler in headless Chromium. The fake
 * export dialog is the live capture's shape (b2-wiw-export-browser.test.ts);
 * its date pickers are invented, since no capture of them exists yet: a
 * calendar popover mounted outside the dialog, a typed field, or nothing.
 * No real When I Work page is opened.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Route } from "@playwright/test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { playwrightExporter } from "@/lib/wiw-export/browser";
import { WiwLogin } from "@/lib/wiw-export/login-file";
import { PROBE_EXIT } from "@/lib/wiw-export/probe";
import { runProbeNextWeek } from "@/lib/wiw-export/probe-next-week";
import { STOP_EXIT } from "@/lib/wiw-export/run";
import { chicagoDateTime } from "@/lib/time";
import { followingWeek } from "@/lib/wiw-export/week";

const ORIGIN = "https://wiw.test";
/** Monday 3 Jun 2030: this week 31 May..6 Jun, next week 7..13 Jun (the calendar opens on May). */
const NOW = chicagoDateTime("2030-06-03", "7:00 pm");
const PERSON = "Brenda Sentinelperson";
const SECRET_EMAIL = "sentinel-login-7q2x@example.invalid";
const SECRET_PASSWORD = "Sentinel-Pass-9Zk!w";

type Fake = {
  picker: "calendar" | "typed" | "none";
  /** The dialog remembers the last dates picked, across a reload. */
  sticky?: boolean;
  /** Sticky, but only the first dates ever picked: a put-back does not stick. */
  stuck?: boolean;
  /** The dialog is a form: Enter in a field submits it (an Export). */
  form?: boolean;
  /** The calendar has no next-month control. */
  noNextMonth?: boolean;
  /** The calendar's forward control is named "Clear and next": the probe must refuse it. */
  trapNext?: boolean;
  noDialog?: boolean;
  mfa?: boolean;
};

type Seen = { exports: number; picks: number; print: number; clear: number; posts: number };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const scheduler = (fake: Fake) => `<h1>Scheduler</h1>
<div class="calendar-strip">week strip</div>
<button>${PERSON} 9a-5p</button>
<button aria-label="More Actions" onclick="document.getElementById('menu').hidden=false">&#8942;</button>
<div id="menu" role="menu" hidden>
  <div role="menuitem" tabindex="0" onclick="fetch('/print')">Print Schedule</div>
  <div role="menuitem" tabindex="0" onclick="${fake.noDialog ? "" : "openDlg()"}">Export Schedule</div>
  <div role="menuitem" tabindex="0" onclick="fetch('/clear')">Clear Schedule</div>
</div>
<${fake.form ? "form action=\"/download\"" : "div"} id="dlg" role="dialog" aria-label="Export Schedule" hidden>
  <button type="button" aria-label="close" onclick="document.getElementById('dlg').hidden=true; closePicker()">&times;</button>
  <button type="button" id="s" aria-label="Start Date" onclick="openPicker('s')"></button>
  <button type="button" id="e" aria-label="End Date" onclick="openPicker('e')"></button>
  <div role="checkbox" tabindex="0" aria-checked="true">Split into separate schedules</div>
  <button onclick="location.href='/download'">Export</button>
</${fake.form ? "form" : "div"}>
<div id="portal"></div>
<script>
const KIND = ${JSON.stringify(fake.picker)};
const STICKY = ${!!fake.sticky || !!fake.stuck};
const STUCK = ${!!fake.stuck};
const NO_NEXT = ${!!fake.noNextMonth};
const TRAP = ${!!fake.trapNext};
const MONTHS = ${JSON.stringify(MONTHS)};
const pad = (n) => String(n).padStart(2, '0');
const shown = (d) => pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear();
function openDlg() {
  const saved = STICKY && localStorage.getItem('range');
  const [s, e] = saved ? JSON.parse(saved) : ['05/31/2030', '06/06/2030'];
  document.getElementById('s').textContent = s;
  document.getElementById('e').textContent = e;
  document.getElementById('dlg').hidden = false;
}
let field = null, month = null;
function closePicker() { document.getElementById('portal').innerHTML = ''; const t = document.getElementById('typed'); if (t) t.remove(); }
function set(value) {
  document.getElementById(field).textContent = value;
  fetch('/pick');
  if (STICKY && !(STUCK && localStorage.getItem('range'))) localStorage.setItem('range', JSON.stringify([document.getElementById('s').textContent, document.getElementById('e').textContent]));
  // The calendar closes on a pick; a typed field stays in the form until the next picker opens.
  document.getElementById('portal').innerHTML = '';
}
function openPicker(id) {
  closePicker();
  field = id;
  if (KIND === 'none') return;
  if (KIND === 'typed') {
    const i = document.createElement('input');
    i.id = 'typed'; i.type = 'text'; i.placeholder = 'MM/DD/YYYY';
    i.addEventListener('change', () => set(i.value));
    document.getElementById(id).after(i);
    i.focus();
    return;
  }
  const [m, , y] = document.getElementById(id).textContent.split('/').map(Number);
  month = new Date(y, m - 1, 1);
  render();
}
function render() {
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  let cells = '';
  for (let d = 1; d <= days; d++) {
    const at = new Date(month.getFullYear(), month.getMonth(), d);
    const label = 'Choose ' + at.toLocaleDateString('en-US', { weekday: 'long' }) + ', ' + MONTHS[at.getMonth()] + ' ' + d + ', ' + at.getFullYear();
    cells += '<div role="option" tabindex="0" aria-label="' + label + '" data-v="' + shown(at) + '">' + d + '</div>';
  }
  const next = NO_NEXT ? '' : TRAP ? '<button onclick="fetch(\\'/clear\\'); month.setMonth(month.getMonth()+1); render()">Clear and next</button>'
    : '<button type="button" aria-label="Previous Month" onclick="month.setMonth(month.getMonth()-1); render()">&lt;</button>' +
      '<button type="button" aria-label="Next Month" onclick="month.setMonth(month.getMonth()+1); render()">&gt;</button>';
  document.getElementById('portal').innerHTML = '<div class="react-datepicker" role="dialog" aria-label="Choose Date"><div>' +
    MONTHS[month.getMonth()] + ' ' + month.getFullYear() + '</div>' + next + '<div role="listbox">' + cells + '</div></div>';
  for (const c of document.querySelectorAll('[data-v]')) c.onclick = () => set(c.dataset.v);
}
</script>`;

const MFA = `<h1>Enter the code</h1><label>Verification code <input name="verification_code" autocomplete="one-time-code"></label>`;
const html = (body: string) => ({ status: 200, contentType: "text/html", body: `<!doctype html><html><body>${body}</body></html>` });

async function serve(context: BrowserContext, fake: Fake, seen: Seen) {
  await context.route(`${ORIGIN}/**`, async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/print") return route.fulfill({ status: 204 }).then(() => void (seen.print += 1));
    if (p === "/clear") return route.fulfill({ status: 204 }).then(() => void (seen.clear += 1));
    if (p === "/pick") return route.fulfill({ status: 204 }).then(() => void (seen.picks += 1));
    if (p === "/login") return route.fulfill({ status: 204 }).then(() => void (seen.posts += 1));
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
  dir = await mkdtemp(path.join(tmpdir(), "b2-nextweek-"));
});

afterAll(async () => {
  await browser?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.relative(root, path.join(e.parentPath, e.name)));
  }
  return out.sort();
}

async function probe(fake: Fake) {
  const seen: Seen = { exports: 0, picks: 0, print: 0, clear: 0, posts: 0 };
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
  const result = await runProbeNextWeek(settings, {
    now: () => NOW,
    readLogin: async () => new WiwLogin(SECRET_EMAIL, SECRET_PASSWORD),
    stepTimeoutMs: 2_000,
    menuSettleMs: 50,
    exporter: (hook) =>
      playwrightExporter({
        profileDir: "/unused",
        schedulerUrl: `${ORIGIN}/scheduler`,
        stepTimeoutMs: 2_000,
        menuSettleMs: 50,
        dialogRetryMs: 300,
        probe: hook,
        // The job's own launch is persistent; the test's context refuses downloads the same way.
        launch: async () => {
          const context = await browser.newContext({ acceptDownloads: false });
          await serve(context, fake, seen);
          return context;
        },
      }),
  });
  const log = await readFile(settings.logFile, "utf8");
  return { result, seen, log, appDir, importDir };
}

describe("B2 probe-next-week (fake scheduler)", { timeout: 60_000 }, () => {
  it("calendar outside the dialog: pages to June, picks Fri 7 and Thu 13, never clicks Export", async () => {
    expect(followingWeek({ friday: "2030-05-31", thursday: "2030-06-06" })).toEqual({ friday: "2030-06-07", thursday: "2030-06-13" });
    const res = await probe({ picker: "calendar" });
    expect(res.result.exitCode).toBe(PROBE_EXIT);
    expect(res.log).toContain("start this=2030-05-31..2030-06-06 next=2030-06-07..2030-06-13");
    expect(res.log).toContain("dialog before start=05/31/2030 end=06/06/2030 week=this");
    expect(res.log).toContain("try field=start picker=page route=calendar pages=1 result=set shows start=06/07/2030 end=06/06/2030");
    expect(res.log).toContain("try field=end picker=page route=calendar pages=0 result=set shows start=06/07/2030 end=06/13/2030");
    expect(res.log).toContain("picker_opens=2");
    expect(res.log).toContain("dialog after start=06/07/2030 end=06/13/2030 week=next");
    expect(res.log).toContain("reached=yes");
    expect(res.log).toContain("export_clicked=no downloads=0");
    expect(res.log).toContain("closed=yes");
    expect(res.log).toContain("reopen start=05/31/2030 end=06/06/2030 week=this");
    expect(res.seen).toMatchObject({ exports: 0, print: 0, clear: 0, picks: 2 });
    // Nothing in the import folder; only the log and the mode-600 probe files under var/log.
    expect(await readdir(res.importDir)).toEqual([]);
    const files = await tree(res.appDir);
    expect(files.filter((f) => !f.startsWith(path.join("var", "log", "wiw-nextweek-")))).toEqual([
      path.join("var", "log", "wiw-export.log"),
    ]);
    for (const suffix of [
      "-1-dialog-open.png",
      "-1-dialog-open.txt",
      "-start-picker.png",
      "-start-picker.aria.yml",
      "-end-picker.png",
      "-end-picker.aria.yml",
      "-2-dialog-after.png",
      "-2-dialog-after.txt",
    ]) {
      expect(files.filter((f) => f.endsWith(suffix))).toHaveLength(1);
    }
    expect(files).toHaveLength(9);
    for (const f of files) if (f.includes("wiw-nextweek-")) expect((await stat(path.join(res.appDir, f))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(res.appDir, files.find((f) => f.endsWith("start-picker.aria.yml"))!), "utf8")).toContain("Choose Friday, May 31, 2030");
    // The log never carries a person, a login value or the page's text.
    for (const secret of [PERSON, "Brenda", SECRET_EMAIL, SECRET_PASSWORD, "Split into"]) expect(res.log).not.toContain(secret);
  });

  it("typed field: types the dates, reaches next week", async () => {
    const res = await probe({ picker: "typed" });
    expect(res.result.exitCode).toBe(PROBE_EXIT);
    expect(res.log).toContain("try field=start picker=none route=typed pages=0 result=set");
    expect(res.log).toContain("try field=end picker=none route=typed pages=0 result=set");
    expect(res.log).toContain("picker_opens=0");
    expect(res.log).toContain("reached=yes");
    expect(res.seen.exports).toBe(0);
  });

  it("no picker: records zero opens and reached=no", async () => {
    const res = await probe({ picker: "none" });
    expect(res.result.exitCode).toBe(PROBE_EXIT);
    expect(res.log).toContain("try field=start picker=none route=none pages=0 result=not_found shows start=05/31/2030 end=06/06/2030");
    expect(res.log).toContain("picker_opens=0");
    expect(res.log).toContain("dialog after start=05/31/2030 end=06/06/2030 week=this");
    expect(res.log).toContain("reached=no");
    expect(res.seen.exports).toBe(0);
  });

  it("calendar with no forward control: stops after the open month, reached=no", async () => {
    const res = await probe({ picker: "calendar", noNextMonth: true });
    expect(res.log).toContain("try field=start picker=page route=calendar pages=0 result=not_found");
    expect(res.log).toContain("reached=no");
  });

  it("refuses a forward control named Clear: no Clear request, reached=no", async () => {
    const res = await probe({ picker: "calendar", trapNext: true });
    expect(res.seen.clear).toBe(0);
    expect(res.log).toContain("reached=no");
    expect(res.seen.exports).toBe(0);
  });

  it("sticky dialog: reopen shows next week, the probe puts this week back and exits 6", async () => {
    const res = await probe({ picker: "calendar", sticky: true });
    expect(res.log).toContain("reached=yes");
    expect(res.log).toContain("reopen start=06/07/2030 end=06/13/2030 week=next");
    expect(res.log).toContain("restore try field=start picker=page route=calendar pages=1 result=set");
    expect(res.log).toContain("restore try field=end picker=page route=calendar pages=0 result=set");
    expect(res.log).toContain("restore week=this");
    expect(res.result.exitCode).toBe(PROBE_EXIT);
    expect(res.seen.exports).toBe(0);
  });

  it("a dialog that will not go back to this week: restore week=other, exit 5 RESTORE", async () => {
    // The fake keeps only the first dates ever picked (the new Start, the old End).
    const res = await probe({ picker: "calendar", stuck: true });
    expect(res.log).toContain("reopen start=06/07/2030 end=06/06/2030 week=other");
    expect(res.log).toContain("restore week=other");
    expect(res.log).toContain("stop=PAGE reason=RESTORE");
    expect(res.result.exitCode).toBe(STOP_EXIT);
    expect(res.seen.exports).toBe(0);
  });

  it("this week on reopen: no restore step", async () => {
    const res = await probe({ picker: "calendar" });
    expect(res.log).not.toContain("restore");
  });

  it("typed field in a form dialog: never presses Enter, so the form never submits", async () => {
    const res = await probe({ picker: "typed", form: true });
    expect(res.seen.exports).toBe(0);
    expect(res.log).toContain("reached=yes");
    expect(res.log).toContain("export_clicked=no downloads=0");
    expect(res.result.exitCode).toBe(PROBE_EXIT);
  });

  it("no dialog: exit 5, no files", async () => {
    const res = await probe({ picker: "calendar", noDialog: true });
    expect(res.result.exitCode).toBe(STOP_EXIT);
    expect(res.log).toContain("stop=PAGE reason=DIALOG_OPEN");
    expect(await tree(res.appDir)).toEqual([path.join("var", "log", "wiw-export.log")]);
  });

  it("a code screen before the menu: exit 5 MFA", async () => {
    const res = await probe({ picker: "calendar", mfa: true });
    expect(res.result.exitCode).toBe(STOP_EXIT);
    expect(res.log).toContain("stop=MFA");
  });
});
