/**
 * The next-week browser step against a fake scheduler in headless Chromium.
 * The dialog is the live capture's shape; its date picker is the live shape
 * Milo captured on 25 Sep (a table of day buttons named "25 September 2026";
 * Start disables days after End, End disables days before Start; a month
 * arrow with nothing to reach is disabled). The fake names its download from
 * the dates the buttons show. No real When I Work page is opened.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Route } from "@playwright/test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FolderImportResult } from "@/lib/import/folder-import";
import { chicagoDateTime } from "@/lib/time";
import { playwrightExporter } from "@/lib/wiw-export/browser";
import { WiwLogin } from "@/lib/wiw-export/login-file";
import { nextWeekDialog } from "@/lib/wiw-export/next-week-dialog";
import { ExportStop, runWiwExport, type ImportRunner } from "@/lib/wiw-export/run";
import { expectedDownloadName, followingWeek, precedingWeek } from "@/lib/wiw-export/week";

const ORIGIN = "https://wiw.test";
/** Monday 3 Jun 2030: this week 31 May..6 Jun, next week 7..13 Jun (the calendar opens on May). */
const NOW = chicagoDateTime("2030-06-03", "7:00 pm");
const THIS = { friday: "2030-05-31", thursday: "2030-06-06" };
const NEXT = { friday: "2030-06-07", thursday: "2030-06-13" };
const PERSON = "Brenda Sentinelperson";
const SECRET_EMAIL = "sentinel-login-7q2x@example.invalid";
const SECRET_PASSWORD = "Sentinel-Pass-9Zk!w";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Fake = {
  /** The dialog remembers the last dates picked, across a reload. */
  sticky?: boolean;
  /** Sticky, but only the first dates ever picked: a put-back does not stick. */
  stuck?: boolean;
  /** Day buttons never take a click (an overlay sits on them). */
  stuckDay?: boolean;
  /** Export closes the dialog, as a real app may. */
  closeOnExport?: boolean;
};

type Seen = { exports: number; picks: number; print: number; clear: number };

const scheduler = (fake: Fake) => `<h1>Scheduler</h1>
<button>${PERSON} 9a-5p</button>
<button aria-label="More Actions" onclick="document.getElementById('menu').hidden=false">&#8942;</button>
<div id="menu" role="menu" hidden>
  <div role="menuitem" tabindex="0" onclick="fetch('/print')">Print Schedule</div>
  <div role="menuitem" tabindex="0" onclick="openDlg()">Export Schedule</div>
  <div role="menuitem" tabindex="0" onclick="fetch('/clear')">Clear Schedule</div>
</div>
<div id="dlg" role="dialog" aria-label="Export Schedule" hidden>
  <button type="button" aria-label="close" onclick="document.getElementById('dlg').hidden=true; closePicker()">&times;</button>
  <button type="button" id="s" aria-label="Start Date" onclick="openPicker('s')"></button>
  <button type="button" id="e" aria-label="End Date" onclick="openPicker('e')"></button>
  <div role="checkbox" tabindex="0" aria-checked="true">Split into separate schedules</div>
  <button onclick="exportNow()">Export</button>
</div>
<div id="portal"></div>
<script>
const STICKY = ${!!fake.sticky || !!fake.stuck};
const STUCK = ${!!fake.stuck};
const STUCK_DAY = ${!!fake.stuckDay};
const CLOSE_ON_EXPORT = ${!!fake.closeOnExport};
const MONTHS = ${JSON.stringify(MONTHS)};
const pad = (n) => String(n).padStart(2, '0');
const shown = (d) => pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + '/' + d.getFullYear();
const parse = (v) => { const [m, d, y] = v.split('/').map(Number); return new Date(y, m - 1, d); };
function openDlg() {
  const saved = STICKY && localStorage.getItem('range');
  const [s, e] = saved ? JSON.parse(saved) : ["05/31/2030", "06/06/2030"];
  document.getElementById('s').textContent = s;
  document.getElementById('e').textContent = e;
  document.getElementById('dlg').hidden = false;
}
function exportNow() {
  location.href = '/download?s=' + encodeURIComponent(document.getElementById('s').textContent) + '&e=' + encodeURIComponent(document.getElementById('e').textContent);
  if (CLOSE_ON_EXPORT) document.getElementById('dlg').hidden = true;
}
let field = null, month = null;
function closePicker() { document.getElementById('portal').innerHTML = ''; }
function set(value) {
  document.getElementById(field).textContent = value;
  fetch('/pick');
  if (STICKY && !(STUCK && localStorage.getItem('range'))) localStorage.setItem('range', JSON.stringify([document.getElementById('s').textContent, document.getElementById('e').textContent]));
  closePicker();
}
function openPicker(id) {
  closePicker();
  field = id;
  const at = parse(document.getElementById(id).textContent);
  month = new Date(at.getFullYear(), at.getMonth(), 1);
  render();
}
function render() {
  const other = parse(document.getElementById(field === 's' ? 'e' : 's').textContent);
  const bad = (at) => field === 's' ? at > other : at < other;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  let cells = '';
  for (let d = 1; d <= days; d++) {
    const at = new Date(month.getFullYear(), month.getMonth(), d);
    cells += '<td><button type="button" aria-label="' + d + ' ' + MONTHS[at.getMonth()] + ' ' + at.getFullYear() + '" data-v="' + shown(at) + '"' + (bad(at) ? ' disabled' : '') + (STUCK_DAY ? ' style="pointer-events:none"' : '') + '>' + d + '</button></td>';
  }
  const nextFirst = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const prevLast = new Date(month.getFullYear(), month.getMonth(), 0);
  const nextOff = field === 's' && nextFirst > other;
  const prevOff = field === 'e' && prevLast < other;
  document.getElementById('portal').innerHTML = '<div role="dialog">' +
    '<button type="button" aria-label="Previous month"' + (prevOff ? ' disabled' : '') + ' onclick="month.setMonth(month.getMonth()-1); render()">&lt;</button>' +
    '<button type="button" aria-label="Change to year view">' + MONTHS[month.getMonth()] + ' ' + month.getFullYear() + '</button>' +
    '<button type="button" aria-label="Next month"' + (nextOff ? ' disabled' : '') + ' onclick="month.setMonth(month.getMonth()+1); render()">&gt;</button>' +
    '<table><tr>' + cells + '</tr></table></div>';
  for (const c of document.querySelectorAll('[data-v]')) c.onclick = () => set(c.dataset.v);
}
</script>`;

const html = (body: string) => ({ status: 200, contentType: "text/html", body: `<!doctype html><html><body>${body}</body></html>` });

function label(mmddyyyy: string): string {
  const [m, d, y] = mmddyyyy.split("/").map(Number);
  return `${MONTHS[m! - 1]!.slice(0, 3)} ${d}, ${y}`;
}

async function serve(context: BrowserContext, fake: Fake, seen: Seen) {
  await context.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/print") return route.fulfill({ status: 204 }).then(() => void (seen.print += 1));
    if (p === "/clear") return route.fulfill({ status: 204 }).then(() => void (seen.clear += 1));
    if (p === "/pick") return route.fulfill({ status: 204 }).then(() => void (seen.picks += 1));
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
    return route.fulfill(html(scheduler(fake)));
  });
}

let browser: Browser;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  dir = await mkdtemp(path.join(tmpdir(), "b2-nextweek-browser-"));
});

afterAll(async () => {
  await browser?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/**
 * One exporter whose launches share one browser context, as the job's
 * persistent profile shares its storage: a sticky dialog is seen by the next
 * launch. `close` leaves the shared context open.
 */
function exporterFor(fake: Fake, seen: Seen, shared: { context: BrowserContext | null }) {
  const opts = { stepTimeoutMs: 2_000, menuSettleMs: 50, actionTimeoutMs: 1_000 };
  return playwrightExporter({
    profileDir: "/unused",
    schedulerUrl: `${ORIGIN}/scheduler`,
    stepTimeoutMs: 2_000,
    menuSettleMs: 50,
    dialogRetryMs: 300,
    downloadTimeoutMs: 5_000,
    nextWeek: nextWeekDialog(opts),
    launch: async () => {
      if (!shared.context) {
        shared.context = await browser.newContext({ acceptDownloads: true });
        await serve(shared.context, fake, seen);
      }
      const ctx = shared.context;
      // The job closes its own context; here closing only drops the pages.
      return new Proxy(ctx, {
        get(target, prop, receiver) {
          if (prop === "close") return async () => Promise.all(target.pages().map((p) => p.close()));
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  });
}

async function nextWeekRun(fake: Fake) {
  const seen: Seen = { exports: 0, picks: 0, print: 0, clear: 0 };
  const shared: { context: BrowserContext | null } = { context: null };
  const lines: string[] = [];
  const ex = exporterFor(fake, seen, shared);
  const login = async () => new WiwLogin(SECRET_EMAIL, SECRET_PASSWORD);
  let name: string | null = null;
  let stop: ExportStop | null = null;
  try {
    const dl = await ex.exportNextWeek!(NEXT, login, async (l) => void lines.push(l));
    name = dl.suggestedName;
    await dl.discard();
  } catch (err) {
    if (!(err instanceof ExportStop)) throw err;
    stop = err;
  } finally {
    await ex.close();
  }
  // What the next timer run finds: this week's export on the same profile.
  let thisWeekAfter: string | null = null;
  const again = exporterFor(fake, seen, shared);
  try {
    const dl = await again.exportWeek(THIS, login);
    thisWeekAfter = dl.suggestedName;
    await dl.discard();
  } catch (err) {
    if (!(err instanceof ExportStop)) throw err;
    thisWeekAfter = `stop=${err.code}:${err.reason ?? ""}`;
  } finally {
    await again.close();
    await shared.context?.close();
  }
  return { name, stop, seen, log: lines.join("\n"), thisWeekAfter };
}

describe("B2 next-week browser step (fake scheduler, live picker shape)", { timeout: 60_000 }, () => {
  it("weeks: following and preceding are seven days apart", () => {
    expect(followingWeek(THIS)).toEqual(NEXT);
    expect(precedingWeek(NEXT)).toEqual(THIS);
  });

  it("sets End then Start, exports next week once, and the next run still opens on this week", async () => {
    const res = await nextWeekRun({});
    expect(res.stop).toBeNull();
    expect(res.name).toBe(expectedDownloadName(NEXT));
    expect(res.log).toContain("order=end,start");
    // 6 Jun to 13 Jun stays in June; Start pages from May to June.
    expect(res.log).toContain("date field=end route=calendar pages=0 result=set");
    expect(res.log).toContain("date field=start route=calendar pages=1 result=set");
    expect(res.log).toContain("dialog start=06/07/2030 end=06/13/2030");
    expect(res.log).toContain("restore week=this");
    // One next-week export here, one this-week export by the following run; never Print or Clear.
    expect(res.seen).toMatchObject({ exports: 2, print: 0, clear: 0, picks: 2 });
    expect(res.thisWeekAfter).toBe(expectedDownloadName(THIS));
    for (const secret of [PERSON, "Brenda", SECRET_EMAIL, SECRET_PASSWORD, "Split into", "September"]) {
      expect(res.log).not.toContain(secret);
    }
  });

  it("Export closes the dialog: restore still reopens and reads this week", async () => {
    const res = await nextWeekRun({ closeOnExport: true });
    expect(res.name).toBe(expectedDownloadName(NEXT));
    expect(res.log).toContain("restore week=this");
    expect(res.thisWeekAfter).toBe(expectedDownloadName(THIS));
  });

  it("sticky dialog: this week is set back after the export, so the next run exports this week", async () => {
    const res = await nextWeekRun({ sticky: true });
    expect(res.name).toBe(expectedDownloadName(NEXT));
    expect(res.log).toContain("restore order=start,end");
    expect(res.log).toContain("restore week=this");
    expect(res.thisWeekAfter).toBe(expectedDownloadName(THIS));
  });

  it("stuck dialog: this week cannot be put back; the log says so and the next run stops on DIALOG_DATE", async () => {
    // The first pick sticks: End 13 Jun with Start still 31 May.
    const res = await nextWeekRun({ stuck: true });
    expect(res.name).toBe(expectedDownloadName(NEXT));
    expect(res.log).toContain("restore week=other");
    expect(res.thisWeekAfter).toBe("stop=PAGE:DIALOG_DATE");
  });

  it("a day that will not take a click: PAGE NEXT_DATE, no export, this week stays", async () => {
    const res = await nextWeekRun({ stuckDay: true });
    expect(res.stop).toMatchObject({ code: "PAGE", reason: "NEXT_DATE" });
    expect(res.name).toBeNull();
    expect(res.log).toContain("restore week=this");
    expect(res.seen.exports).toBe(1);
    expect(res.thisWeekAfter).toBe(expectedDownloadName(THIS));
  });

  it("whole run: this week, then next week by its own path and week; both files deleted", async () => {
    const seen: Seen = { exports: 0, picks: 0, print: 0, clear: 0 };
    const shared: { context: BrowserContext | null } = { context: null };
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
    const calls: Array<{ file: string | undefined; week: string | undefined; bytes: string }> = [];
    const runImport: ImportRunner = async (_dir, _now, target) => {
      calls.push({
        file: target?.file && path.basename(target.file),
        week: target?.week && `${target.week.friday}..${target.week.thursday}`,
        bytes: target?.file ? await readFile(target.file, "utf8") : "",
      });
      const result: FolderImportResult = {
        outcome: "imported",
        mode: "apply",
        file: target?.file ? path.basename(target.file) : null,
        code: null,
        rowCount: 1,
        dates: [],
        refusals: {},
      };
      return result;
    };
    try {
      const res = await runWiwExport(settings, {
        exporter: exporterFor({}, seen, shared),
        readLogin: async () => new WiwLogin(SECRET_EMAIL, SECRET_PASSWORD),
        runImport,
        now: () => NOW,
      });
      expect(res.exitCode).toBe(0);
      expect(res.next.status).toBe("imported");
    } finally {
      await shared.context?.close();
    }
    expect(calls).toEqual([
      { file: "Schedule_for_2030-05-31_2030-06-06.xlsx", week: undefined, bytes: "FAKE-XLSX" },
      { file: "Schedule_for_2030-06-07_2030-06-13.xlsx", week: "2030-06-07..2030-06-13", bytes: "FAKE-XLSX" },
    ]);
    expect(await readdir(importDir)).toEqual([]);
    const log = await readFile(settings.logFile, "utf8");
    expect(log).toContain("next saved file=Schedule_for_2030-06-07_2030-06-13.xlsx");
    expect(log).toContain("next restore week=this");
    expect(log).toContain("next=imported");
    expect(seen).toMatchObject({ exports: 2, print: 0, clear: 0 });
  });
});
