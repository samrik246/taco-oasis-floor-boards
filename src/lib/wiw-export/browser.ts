/**
 * The browser half of the When I Work export (B2, CB-006 steps).
 *
 * A headed Chromium with its own user-data folder (never the Tron Chrome
 * profile), in the logged-in GUI session of the user that runs the boards.
 * Cookies stay in that folder, so a later run stays signed in until When I
 * Work asks again.
 *
 * Steps: open the scheduler; if the sign-in page is up, type the two fields
 * from the locked file once and click Sign in; open More Actions, wait for the
 * menu to settle, click Export Schedule (never Print or Clear), once more if
 * the fade swallowed the click; read the Start and End buttons, which When I
 * Work opens on the displayed week, and check they show this Friday and
 * Thursday (the date pickers are never opened); leave the filters on All and
 * Split checked; click Export once and wait for the file.
 *
 * The dialog selectors come from the live capture of 24 Sep 2026 (probe on
 * T MAC MINI): dialog "Export Schedule", buttons "Start Date" and "End Date"
 * showing MM/dd/yyyy, checkbox "Split into separate schedules", button
 * "Export". Role locators skip hidden elements.
 *
 * Any screen these steps do not expect stops the run with a code: LOGIN, MFA,
 * CAPTCHA or PAGE. No tracing, no screenshots, no video, and no page text or
 * field value leaves this file.
 */
import type { BrowserContext, Download, Locator, Page } from "@playwright/test";
import type { WiwLogin } from "./login-file";
import { ExportStop, type DownloadedExport, type ScheduleExporter } from "./run";
import { dialogDate, type ExportWeek } from "./week";

export const SCHEDULER_URL = "https://appx.wheniwork.com/scheduler";

export type BrowserOptions = {
  profileDir: string;
  /** Headed on the Mac (CB-006). Tests run headless against a fake page. */
  headless?: boolean;
  /** Tests point this at a fake scheduler. */
  schedulerUrl?: string;
  /** Per-step wait. */
  stepTimeoutMs?: number;
  /** Wait for the download after Export. */
  downloadTimeoutMs?: number;
  /** The More Actions menu fades in; a click mid-fade is swallowed. */
  menuSettleMs?: number;
  /** Wait for the dialog before clicking Export Schedule once more. */
  dialogRetryMs?: number;
  /** Tests pass a context; the job launches its own. */
  launch?: () => Promise<BrowserContext>;
  /**
   * Probe mode: called after the dialog wait (retry included), then the run
   * ends with ProbeDone. The dialog's Export button is never clicked.
   */
  probe?: (page: Page) => Promise<void>;
};

/** A probe run reached the dialog step and captured it. Not an export. */
export class ProbeDone extends Error {
  constructor() {
    super("PROBE_DONE");
    this.name = "ProbeDone";
  }
}

type Screen = "scheduler" | "login" | "mfa" | "captcha";

const CAPTCHA_FRAMES =
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], iframe[title*="captcha" i]';
const MFA_FIELDS =
  'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="mfa" i], input[name*="verification" i], input[name*="2fa" i]';
const MFA_TEXT = /verification code|two-factor|2-step|authentication code|enter the code|security code/i;

function moreActions(page: Page): Locator {
  return page.getByRole("button", { name: /more actions/i });
}

function passwordField(page: Page): Locator {
  return page.locator('input[type="password"]');
}

function emailField(page: Page): Locator {
  return page.locator('input[type="email"], input[name="email" i], input[autocomplete="username"]');
}

async function visible(l: Locator): Promise<boolean> {
  return (await l.count()) > 0 && (await l.first().isVisible());
}

/** Wait until the page is one of the screens this job knows, or stop with PAGE. */
async function screenOf(page: Page, timeoutMs: number): Promise<Screen> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await page.locator(CAPTCHA_FRAMES).count()) > 0) return "captcha";
    if (await visible(page.locator(MFA_FIELDS))) return "mfa";
    if (await visible(passwordField(page))) return "login";
    if (await visible(moreActions(page))) return "scheduler";
    const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
    if (MFA_TEXT.test(body) && !(await visible(passwordField(page)))) return "mfa";
    if (Date.now() >= until) throw new ExportStop("PAGE", "UNKNOWN_SCREEN");
    await page.waitForTimeout(250);
  }
}

function stopFor(screen: Exclude<Screen, "scheduler" | "login">): ExportStop {
  return new ExportStop(screen === "mfa" ? "MFA" : "CAPTCHA");
}

/** Type the two fields once and click Sign in. What comes next is read by the caller. */
async function signIn(page: Page, login: WiwLogin, timeoutMs: number): Promise<void> {
  const email = emailField(page);
  const password = passwordField(page);
  if (!(await visible(email)) || !(await visible(password))) throw new ExportStop("PAGE", "LOGIN_FORM");
  const submit = page
    .locator('button[type="submit"], input[type="submit"]')
    .or(page.getByRole("button", { name: /^(sign in|log in|login)$/i }));
  if ((await submit.count()) === 0) throw new ExportStop("PAGE", "LOGIN_FORM");
  const fields = login.reveal();
  await email.first().fill(fields.email);
  await password.first().fill(fields.password);
  await submit.first().click();
  // Wait for the sign-in page to go. Still up after the wait: wrong password or a changed form.
  const gone = await password
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!gone) throw new ExportStop("LOGIN", "REJECTED");
}

/** The export dialog, as captured: role dialog, name Export Schedule. */
export function exportDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Export Schedule", exact: true });
}

/** The dialog controls the export checks. Visible matches only (role locators). */
export function dialogControls(box: Locator) {
  return {
    start: box.getByRole("button", { name: "Start Date", exact: true }),
    end: box.getByRole("button", { name: "End Date", exact: true }),
    split: box.getByRole("checkbox", { name: /^split into separate schedules$/i }),
    submit: box.getByRole("button", { name: /^export$/i }),
  };
}

const SHOWN_DATE = /\b\d{2}\/\d{2}\/\d{4}\b/g;

/** The one MM/dd/yyyy date a date button shows, or null. Never clicks it. */
async function shownDate(button: Locator): Promise<string | null> {
  const text = (await button.innerText().catch(() => "")) || ((await button.getAttribute("value").catch(() => null)) ?? "");
  const found = text.match(SHOWN_DATE) ?? [];
  return found.length === 1 ? found[0]! : null;
}

async function checkDate(button: Locator, expected: string): Promise<void> {
  if ((await button.count()) !== 1 || (await shownDate(button)) !== expected) throw new ExportStop("PAGE", "DIALOG_DATE");
}

async function shows(l: Locator, timeoutMs: number): Promise<boolean> {
  return l
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

function wrap(download: Download): DownloadedExport {
  return {
    suggestedName: download.suggestedFilename(),
    saveAs: (target) => download.saveAs(target),
    discard: () => download.delete(),
  };
}

export function playwrightExporter(opts: BrowserOptions): ScheduleExporter {
  const step = opts.stepTimeoutMs ?? 30_000;
  let context: BrowserContext | null = null;

  const launch =
    opts.launch ??
    (async () => {
      const { chromium } = await import("@playwright/test");
      return chromium.launchPersistentContext(opts.profileDir, {
        headless: opts.headless ?? false,
        acceptDownloads: true,
        viewport: { width: 1440, height: 900 },
      });
    });

  return {
    async exportWeek(week: ExportWeek, readLogin: () => Promise<WiwLogin>, note?: (line: string) => Promise<void>) {
      try {
        context = await launch();
      } catch {
        // No GUI session, or Chromium is not installed for this user.
        throw new ExportStop("PAGE", "BROWSER");
      }
      context.setDefaultTimeout(step);
      const page = context.pages()[0] ?? (await context.newPage());
      const url = opts.schedulerUrl ?? SCHEDULER_URL;

      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch {
        throw new ExportStop("PAGE", "OPEN");
      }

      let screen: Screen | null = await screenOf(page, step);
      if (screen === "login") {
        await signIn(page, await readLogin(), step);
        // Signed in, When I Work may land on another page first: open the scheduler again.
        screen = await screenOf(page, step).catch(() => null);
        if (screen === null) {
          await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
          screen = await screenOf(page, step);
        }
        // Back on the sign-in page: wrong password or a changed form. Never a second try.
        if (screen === "login") throw new ExportStop("LOGIN", "REJECTED");
      }
      if (screen === "mfa" || screen === "captcha") throw stopFor(screen);

      // More Actions, then Export Schedule only.
      await moreActions(page).first().click();
      const exportItem = page.getByRole("menuitem", { name: /^export schedule$/i })
        .or(page.getByRole("button", { name: /^export schedule$/i }))
        .or(page.getByRole("link", { name: /^export schedule$/i }));
      try {
        await exportItem.first().waitFor({ state: "visible", timeout: step });
      } catch {
        throw new ExportStop("PAGE", "MENU");
      }
      await page.waitForTimeout(opts.menuSettleMs ?? 800);
      await exportItem.first().click();

      // The fade can swallow the click: no dialog, menu still open. Click the same item once more.
      const dialog = exportDialog(page);
      let opened = await shows(dialog, opts.dialogRetryMs ?? 3_000);
      if (!opened && (await exportItem.first().isVisible().catch(() => false)) && (await dialog.count()) === 0) {
        await note?.("menu retry=1");
        await exportItem.first().click();
        opened = await shows(dialog, step);
      } else if (!opened) {
        opened = await shows(dialog, step);
      }
      if (opts.probe) {
        await opts.probe(page);
        throw new ProbeDone();
      }
      if (!opened) throw new ExportStop("PAGE", "DIALOG_OPEN");

      const box = dialog.first();
      const { start, end, split, submit } = dialogControls(box);
      await checkDate(start, dialogDate(week.friday));
      await checkDate(end, dialogDate(week.thursday));

      if ((await split.count()) !== 1 || !(await split.isChecked())) throw new ExportStop("PAGE", "DIALOG_SPLIT");

      if ((await submit.count()) !== 1) throw new ExportStop("PAGE", "DIALOG_EXPORT");
      const downloaded = page.waitForEvent("download", { timeout: opts.downloadTimeoutMs ?? 120_000 });
      await submit.click();
      try {
        return wrap(await downloaded);
      } catch {
        throw new ExportStop("PAGE", "NO_DOWNLOAD");
      }
    },

    async close() {
      const c = context;
      context = null;
      if (c) await c.close();
    },
  };
}
