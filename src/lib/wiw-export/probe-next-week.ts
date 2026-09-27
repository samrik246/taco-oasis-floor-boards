/**
 * Next-week probe for the When I Work export (B2 lane 2). Read-only: it finds
 * out whether the export dialog can be set to the following Friday through
 * Thursday, before any browser step for that week is written.
 *
 * Same steps as a run up to the dialog wait (sign-in and menu unchanged).
 * Then, in the open Export Schedule dialog:
 * - read the Start and End buttons (this week, as the export expects);
 * - set End before Start when moving later (When I Work disables Start days
 *   after End), Start before End when moving back; for each,
 *   click the date button, record whether a date picker opened, and try to pick
 *   the following Friday: type it if the picker is a text field, else click
 *   the day in the calendar, paging forward at most twice;
 * - the same for End Date and the following Thursday;
 * - read the two buttons again;
 * - close the dialog with its close button, reload the scheduler, open the
 *   dialog once more and read which week it opens on (the timer's next run
 *   uses the same browser folder), then close it;
 * - if it did not open on this week: set Start/End back to this week the
 *   same way, close, reopen and log `restore week=`. Anything but `this`
 *   exits 5 (`reason=RESTORE`).
 *
 * A typed date is committed with Tab, never Enter: in a form dialog Enter
 * would submit it, an Export by another route.
 *
 * To tell a newly opened picker from what was already on screen, the probe
 * marks the visible picker-shaped elements and dialogs with a
 * `data-probe-before` attribute in the page (in the browser only; When I Work
 * gets nothing).
 *
 * Each action inside the dialog logs `step=<name>` first and has its own
 * 5-second timeout; a throw logs `step_error=<name> error=<class>
 * call=<api>` (never the message text) and the probe goes on to close,
 * reopen and, when needed, restore. The log then says `profile=clear|unchecked`.
 * Exit 6 only when next week was reached with no step error and the profile is
 * clear; otherwise exit 5 with reason RESTORE, STEP or NOT_REACHED.
 *
 * Never clicked: the dialog's Export button, or any control named Export,
 * Print, Clear, Publish, Delete, Save, Remove or Submit (`safeClick`). The
 * browser runs with downloads refused. Nothing goes to the import folder, no
 * import runs, no timer is written or loaded.
 *
 * Files, all mode 600 under var/log, staying on the Mac: element screenshots
 * of the dialog and of the picker (never the page: the scheduler behind it
 * shows people's names), the dialog's text, and the picker's ARIA snapshot.
 * The log gets fixed codes, counts and the dates the buttons show.
 */
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { format, parseISO } from "date-fns";
import type { Locator, Page } from "@playwright/test";
import { dialogControls, exportDialog, ProbeDone } from "./browser";
import { LoginFileError, type WiwLogin } from "./login-file";
import { PROBE_EXIT } from "./probe";
import { ExportStop, STOP_EXIT, type ScheduleExporter, type StopCode, type WiwExportSettings } from "./run";
import { dialogDate, exportWeekFor, followingWeek, type ExportWeek } from "./week";

/** Never clicked by the probe, whatever the scope. */
const FORBIDDEN = /\b(export|print|clear|publish|delete|save|remove|submit|download)\b/i;

/** A date picker, wherever the page mounts it. */
const PICKER =
  '[role="grid"], [role="application"], .react-datepicker, .rdp, .DayPicker, [class*="datepicker" i], [class*="date-picker" i], [class*="calendar" i]';

const SHOWN_DATE = /\b\d{2}\/\d{2}\/\d{4}\b/g;

export type Shown = { start: string | null; end: string | null };

export type FieldTry = {
  field: "start" | "end";
  /** Where the picker was found: inside the dialog, elsewhere on the page, or not at all. */
  picker: "dialog" | "page" | "none";
  route: "typed" | "calendar" | "already" | "none";
  pages: number;
  result: "set" | "not_found" | "refused_click" | "disabled" | "error";
  shownAfter: Shown;
};

export type NextWeekCapture = {
  thisWeek: ExportWeek;
  nextWeek: ExportWeek;
  before: Shown;
  tries: FieldTry[];
  after: Shown;
  pickerOpens: number;
  reached: boolean;
  closed: boolean;
  reopen: Shown | "failed";
  /** Set only when the reopen did not show this week: the put-back tries and the week shown after. */
  restore: { tries: FieldTry[]; shown: Shown | "failed"; week: string } | null;
  /** Steps that threw, in order. */
  stepErrors: string[];
  files: string[];
};

export type NextWeekResult = {
  exitCode: number;
  stop: StopCode | null;
  capture: NextWeekCapture | null;
  downloads: number;
};

async function shownDate(button: Locator): Promise<string | null> {
  if ((await button.count()) !== 1) return null;
  const text = (await button.innerText().catch(() => "")) || ((await button.getAttribute("value").catch(() => null)) ?? "");
  const found = text.match(SHOWN_DATE) ?? [];
  return found.length === 1 ? found[0]! : null;
}

async function readShown(box: Locator): Promise<Shown> {
  const c = dialogControls(box);
  return { start: await shownDate(c.start), end: await shownDate(c.end) };
}

async function firstVisible(l: Locator): Promise<Locator | null> {
  for (const item of await l.all()) if (await item.isVisible().catch(() => false)) return item;
  return null;
}

/** Click only a control whose name and text carry none of the forbidden words. */
export type ClickResult = "clicked" | "refused" | "disabled";

/**
 * Click only a control whose name and text carry none of the forbidden words,
 * and never a disabled one: `click()` on a disabled control waits out the
 * whole timeout (the 30 s stall of the first live run, a disabled Next month).
 */
export async function safeClick(l: Locator): Promise<ClickResult> {
  const label = [
    await l.getAttribute("aria-label").catch(() => null),
    await l.getAttribute("title").catch(() => null),
    await l.innerText().catch(() => ""),
  ]
    .filter(Boolean)
    .join(" ");
  if (FORBIDDEN.test(label)) return "refused";
  const disabled =
    (await l.isDisabled({ timeout: 1_000 }).catch(() => false)) ||
    (await l.getAttribute("aria-disabled").catch(() => null)) === "true";
  if (disabled) return "disabled";
  await l.click();
  return "clicked";
}

/** Accessible names a calendar gives one day. */
function dayName(ymd: string): RegExp {
  const d = parseISO(ymd);
  const day = format(d, "d");
  const months = `${format(d, "MMMM")}|${format(d, "MMM")}`;
  return new RegExp(
    `(\\b(${months})\\s+${day}(st|nd|rd|th)?,?\\s+${format(d, "yyyy")}\\b)|(^|\\s)${day}\\s+(${months})\\s+${format(d, "yyyy")}\\b|${format(d, "yyyy-MM-dd")}|${format(d, "MM/dd/yyyy")}`,
    "i",
  );
}

async function findDay(picker: Locator, ymd: string): Promise<Locator | null> {
  const name = dayName(ymd);
  const byRole = picker
    .getByRole("gridcell", { name })
    .or(picker.getByRole("button", { name }))
    .or(picker.getByRole("option", { name }));
  const hit = await firstVisible(byRole);
  if (hit) return hit;
  for (const item of await picker.locator("[aria-label]").all()) {
    if (name.test((await item.getAttribute("aria-label").catch(() => null)) ?? "") && (await item.isVisible().catch(() => false))) {
      return item;
    }
  }
  return firstVisible(
    picker.locator(`[data-date="${ymd}"], [data-day="${ymd}"], [data-value="${ymd}"], time[datetime="${ymd}"]`),
  );
}

type Files = { stamp: string; dir: string; list: string[] };

async function save(files: Files, suffix: string, body: string | Buffer): Promise<void> {
  const file = path.join(files.dir, `wiw-nextweek-${files.stamp}-${suffix}`);
  await writeFile(file, body, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  files.list.push(path.basename(file));
}

async function shoot(files: Files, l: Locator, suffix: string): Promise<void> {
  const png = await l.screenshot({ animations: "disabled" }).catch(() => null);
  if (png) await save(files, suffix, png);
}

const PICKER_OR_DIALOG = `:is(${PICKER}, [role="dialog"])`;
const SEEN = "data-probe-before";

/** Mark every picker-shaped element and dialog already on screen, so the click's new one stands out. */
async function markVisible(page: Page): Promise<void> {
  await page.evaluate(
    ([sel, attr]) => {
      for (const e of Array.from(document.querySelectorAll(sel!))) {
        e.removeAttribute(attr!);
        if (e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden") e.setAttribute(attr!, "");
      }
    },
    [PICKER_OR_DIALOG, SEEN],
  );
}

/** The picker a date button opened: new on screen since `markVisible`, inside the dialog first. */
async function openedPicker(page: Page, box: Locator): Promise<{ where: "dialog" | "page"; picker: Locator } | null> {
  const fresh = `${PICKER_OR_DIALOG}:not([${SEEN}])`;
  const inDialog = await firstVisible(box.locator(fresh));
  if (inDialog) return { where: "dialog", picker: inDialog };
  const onPage = await firstVisible(page.locator(fresh));
  if (onPage) return { where: "page", picker: onPage };
  return null;
}

/** Live step markers: `step=<name>` before each action, `step_error=<name> error=<class> call=<api>` on a throw. */
export type Steps = { log: (line: string) => Promise<void>; errors: string[] };

/** A step threw. Carries the step name only. */
class StepFailed extends Error {
  constructor(readonly step: string) {
    super(step);
    this.name = "StepFailed";
  }
}

/**
 * The error's class and the Playwright call that threw ("locator.click"), from
 * the head of its message. Never the rest of the message: it can quote the page.
 */
export function errorCode(err: unknown): string {
  const cls = err instanceof Error ? err.name.replace(/[^A-Za-z]/g, "") || "Error" : "Unknown";
  const call = err instanceof Error ? /^([A-Za-z]+\.[A-Za-z]+):/.exec(err.message)?.[1] : undefined;
  return `error=${cls} call=${call ?? "-"}`;
}

async function step<T>(steps: Steps, name: string, fn: () => Promise<T>): Promise<T> {
  await steps.log(`step=${name}`);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StepFailed) throw err;
    steps.errors.push(name);
    await steps.log(`step_error=${name} ${errorCode(err)}`);
    throw new StepFailed(name);
  }
}

/** MM/dd/yyyy to yyyy-MM-dd. */
function isoOf(shown: string): string {
  const [m, d, y] = shown.split("/");
  return `${y}-${m}-${d}`;
}

async function trySet(
  page: Page,
  box: Locator,
  field: "start" | "end",
  ymd: string,
  files: Files,
  counts: { pickerOpens: number },
  steps: Steps,
  /** Step and file-name prefix: "" for the next-week try, "restore-" for putting this week back. */
  tag = "",
): Promise<FieldTry> {
  const c = dialogControls(box);
  const button = field === "start" ? c.start : c.end;
  const want = dialogDate(ymd);
  const name = `${tag ? "restore." : ""}${field}`;
  const shownNow = await step(steps, `${name}.read`, () => readShown(box));
  if ((field === "start" ? shownNow.start : shownNow.end) === want) {
    return { field, picker: "none", route: "already", pages: 0, result: "set", shownAfter: shownNow };
  }
  const out: FieldTry = { field, picker: "none", route: "none", pages: 0, result: "not_found", shownAfter: shownNow };
  try {
    const opened = await step(steps, `${name}.open`, async () => {
      await markVisible(page);
      const clicked = await safeClick(button.first());
      if (clicked !== "clicked") return clicked;
      await page.waitForTimeout(800);
      return openedPicker(page, box);
    });
    if (opened === "refused" || opened === "disabled") {
      if (opened === "disabled") await steps.log(`step_disabled=${name}.open`);
      out.result = opened === "refused" ? "refused_click" : "disabled";
      return out;
    }
    if (opened) counts.pickerOpens += 1;
    out.picker = opened?.where ?? "none";
    if (opened) {
      await step(steps, `${name}.capture`, async () => {
        await shoot(files, opened.picker, `${tag}${field}-picker.png`);
        await save(files, `${tag}${field}-picker.aria.yml`, `${await opened.picker.ariaSnapshot().catch(() => "")}\n`);
      });
    }

    // A text field took focus (typed picker): type the date, then Tab out. Never Enter:
    // in a form dialog Enter submits, which is an Export by another route.
    const FOCUSED = "input:focus, [contenteditable='true']:focus";
    const focused = opened ? box.locator(FOCUSED).or(opened.picker.locator(FOCUSED)) : box.locator(FOCUSED);
    if ((await focused.count()) === 1 && (await focused.isVisible().catch(() => false))) {
      out.route = "typed";
      await step(steps, `${name}.fill`, async () => {
        await focused.fill(want);
        await focused.press("Tab");
        await page.waitForTimeout(500);
      });
    } else if (opened) {
      out.route = "calendar";
      // Page toward the date: forward for next week, back when putting this week back.
      const current = field === "start" ? shownNow.start : shownNow.end;
      const back = current !== null && ymd < isoOf(current);
      const word = back ? /prev|previous|back/i : /next/i;
      const attr = back ? '[aria-label*="prev" i]' : '[aria-label*="next" i]';
      let day = await step(steps, `${name}.find`, () => findDay(opened.picker, ymd));
      while (!day && out.pages < 2) {
        const moved = await step(steps, `${name}.${back ? "prev" : "next"}`, async () => {
          const arrow = await firstVisible(opened.picker.getByRole("button", { name: word }).or(opened.picker.locator(attr)));
          if (!arrow) return false;
          const clicked = await safeClick(arrow);
          if (clicked === "disabled") await steps.log(`step_disabled=${name}.${back ? "prev" : "next"}`);
          if (clicked !== "clicked") return false;
          await page.waitForTimeout(400);
          return true;
        });
        if (!moved) break;
        out.pages += 1;
        day = await step(steps, `${name}.find`, () => findDay(opened.picker, ymd));
      }
      if (day) {
        const clicked = await step(steps, `${name}.day`, async () => {
          const r = await safeClick(day);
          if (r === "disabled") await steps.log(`step_disabled=${name}.day`);
          if (r === "clicked") await page.waitForTimeout(500);
          return r;
        });
        if (clicked !== "clicked") out.result = clicked === "disabled" ? "disabled" : "refused_click";
      }
    }
    out.shownAfter = await step(steps, `${name}.read`, () => readShown(box));
    if (out.result === "not_found" && (field === "start" ? out.shownAfter.start : out.shownAfter.end) === want) {
      out.result = "set";
    }
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    out.result = "error";
    out.shownAfter = await readShown(box).catch(() => ({ start: null, end: null }));
  }
  return out;
}

async function closeDialog(page: Page, box: Locator): Promise<boolean> {
  const close = box.getByRole("button", { name: "close", exact: true });
  if ((await close.count()) === 1 && (await close.isVisible().catch(() => false))) await safeClick(close);
  if (await box.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  return box
    .waitFor({ state: "hidden", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
}

/** Reload the scheduler and open the dialog once more, as the timer will. The dialog, or null. */
async function reopen(page: Page, step: number, menuSettleMs: number, steps: Steps): Promise<Locator | null> {
  await steps.log("step=reopen");
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    const more = page.getByRole("button", { name: /more actions/i });
    await more.first().waitFor({ state: "visible", timeout: step });
    await more.first().click();
    const item = page
      .getByRole("menuitem", { name: /^export schedule$/i })
      .or(page.getByRole("button", { name: /^export schedule$/i }))
      .or(page.getByRole("link", { name: /^export schedule$/i }));
    await item.first().waitFor({ state: "visible", timeout: step });
    await page.waitForTimeout(menuSettleMs);
    await item.first().click();
    const dialog = exportDialog(page);
    if (!(await dialog.first().waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false))) {
      if (await item.first().isVisible().catch(() => false)) await item.first().click();
      await dialog.first().waitFor({ state: "visible", timeout: step });
    }
    return dialog.first();
  } catch (err) {
    steps.errors.push("reopen");
    await steps.log(`step_error=reopen ${errorCode(err)}`);
    return null;
  }
}

/** Reopen, read the dates, close. */
async function reopenAndRead(page: Page, step: number, menuSettleMs: number, steps: Steps): Promise<Shown | "failed"> {
  const box = await reopen(page, step, menuSettleMs, steps);
  if (!box) return "failed";
  const shown = await readShown(box).catch(() => "failed" as const);
  await safeClose(page, box, steps);
  return shown;
}

/** Close, logged as a step; a failure is recorded and the probe goes on. */
async function safeClose(page: Page, box: Locator, steps: Steps): Promise<boolean> {
  return step(steps, "close", () => closeDialog(page, box)).catch(() => false);
}

export function weekOf(shown: Shown | "failed", thisWeek: ExportWeek, nextWeek: ExportWeek): string {
  if (shown === "failed") return "failed";
  if (shown.start === dialogDate(thisWeek.friday) && shown.end === dialogDate(thisWeek.thursday)) return "this";
  if (shown.start === dialogDate(nextWeek.friday) && shown.end === dialogDate(nextWeek.thursday)) return "next";
  return "other";
}

/**
 * Both dates, in the order the picker allows. When I Work disables Start days
 * after End (and End days before Start): moving later sets End first, moving
 * earlier sets Start first.
 */
async function setWeek(
  page: Page,
  box: Locator,
  target: ExportWeek,
  files: Files,
  counts: { pickerOpens: number },
  steps: Steps,
  tag = "",
  startFirst = false,
): Promise<FieldTry[]> {
  const shown = await readShown(box).catch(() => ({ start: null, end: null }) as Shown);
  const later = shown.end === null || target.thursday > isoOf(shown.end);
  const order: Array<["start" | "end", string]> = later && !startFirst
    ? [["end", target.thursday], ["start", target.friday]]
    : [["start", target.friday], ["end", target.thursday]];
  await steps.log(`${tag ? "restore " : ""}order=${order.map(([f]) => f).join(",")}`);
  const tries: FieldTry[] = [];
  for (const [field, ymd] of order) {
    if (!(await box.isVisible().catch(() => false))) break;
    tries.push(await trySet(page, box, field, ymd, files, counts, steps, tag));
  }
  return tries;
}

export async function captureNextWeek(
  page: Page,
  week: ExportWeek,
  opts: {
    logDir: string;
    stamp: string;
    step: number;
    menuSettleMs: number;
    actionTimeoutMs: number;
    steps: Steps;
    /** Tests only: the first live run's Start-then-End order. */
    startFirst?: boolean;
  },
): Promise<NextWeekCapture | null> {
  const { steps } = opts;
  const dialog = exportDialog(page);
  if ((await dialog.count()) === 0) return null;
  // A stuck control fails in seconds, so the close/reopen/restore steps still run.
  page.setDefaultTimeout(opts.actionTimeoutMs);
  const box = dialog.first();
  const nextWeek = followingWeek(week);
  const files: Files = { stamp: opts.stamp, dir: opts.logDir, list: [] };
  const counts = { pickerOpens: 0 };
  const none: Shown = { start: null, end: null };

  const before = await step(steps, "dialog.read", () => readShown(box)).catch(() => none);
  await step(steps, "dialog.capture", async () => {
    await shoot(files, box, "1-dialog-open.png");
    await save(files, "1-dialog-open.txt", `${await box.innerText().catch(() => "")}\n`);
  }).catch(() => undefined);

  const tries = await setWeek(page, box, nextWeek, files, counts, steps, "", opts.startFirst);
  const open = await box.isVisible().catch(() => false);
  const after = open ? await step(steps, "after.read", () => readShown(box)).catch(() => none) : none;
  if (open) {
    await step(steps, "after.capture", async () => {
      await shoot(files, box, "2-dialog-after.png");
      await save(files, "2-dialog-after.txt", `${await box.innerText().catch(() => "")}\n`);
    }).catch(() => undefined);
  }
  const reached = after.start === dialogDate(nextWeek.friday) && after.end === dialogDate(nextWeek.thursday);
  const closed = open ? await safeClose(page, box, steps) : true;

  // Always, whatever failed above: the timer shares this browser folder. If the
  // dialog now opens on anything but this week, put this week back the same safe
  // way and read it once more.
  const again = await reopenAndRead(page, opts.step, opts.menuSettleMs, steps);
  let restore: NextWeekCapture["restore"] = null;
  if (weekOf(again, week, nextWeek) !== "this") {
    const box2 = await reopen(page, opts.step, opts.menuSettleMs, steps);
    const restoreTries: FieldTry[] = [];
    if (box2) {
      restoreTries.push(...(await setWeek(page, box2, week, files, counts, steps, "restore-")));
      if (await box2.isVisible().catch(() => false)) await safeClose(page, box2, steps);
    }
    const check = await reopenAndRead(page, opts.step, opts.menuSettleMs, steps);
    restore = { tries: restoreTries, shown: check, week: weekOf(check, week, nextWeek) };
  }
  return {
    thisWeek: week,
    nextWeek,
    before,
    tries,
    after,
    pickerOpens: counts.pickerOpens,
    reached,
    closed,
    reopen: again,
    restore,
    stepErrors: [...steps.errors],
    files: files.list,
  };
}

export type NextWeekDeps = {
  /** Built with `probe` set and downloads refused; the probe hook is attached here. */
  exporter: (probe: (page: Page) => Promise<void>) => ScheduleExporter;
  readLogin: () => Promise<WiwLogin>;
  now?: () => Date;
  stepTimeoutMs?: number;
  menuSettleMs?: number;
  /** Per-action timeout inside the dialog. */
  actionTimeoutMs?: number;
  /** Tests only: set Start before End, as the first live run did. */
  startFirst?: boolean;
};

const d = (s: string | null) => s ?? "-";

export async function runProbeNextWeek(settings: WiwExportSettings, deps: NextWeekDeps): Promise<NextWeekResult> {
  const now = deps.now ?? (() => new Date());
  const logDir = path.dirname(settings.logFile);
  await mkdir(logDir, { recursive: true });
  const log = (line: string) => appendFile(settings.logFile, `${now().toISOString()} wiw-export probe-next-week ${line}\n`);
  const week = exportWeekFor(now());
  const next = followingWeek(week);
  await log(`start this=${week.friday}..${week.thursday} next=${next.friday}..${next.thursday}`);

  let capture: NextWeekCapture | null = null;
  let downloads = 0;
  let hooked = false;
  const exporter = deps.exporter(async (page) => {
    hooked = true;
    page.context().on("page", (p) => p.on("download", (dl) => void ((downloads += 1), dl.cancel().catch(() => undefined))));
    page.on("download", (dl) => void ((downloads += 1), dl.cancel().catch(() => undefined)));
    capture = await captureNextWeek(page, week, {
      logDir,
      stamp: now().toISOString().replace(/[:.]/g, "-"),
      step: deps.stepTimeoutMs ?? 30_000,
      menuSettleMs: deps.menuSettleMs ?? 800,
      actionTimeoutMs: deps.actionTimeoutMs ?? 5_000,
      steps: { log, errors: [] },
      startFirst: deps.startFirst,
    });
  });

  let stop: ExportStop | null = null;
  let thrown: string | null = null;
  try {
    const download = await exporter.exportWeek(week, async () => {
      try {
        return await deps.readLogin();
      } catch (err) {
        throw new ExportStop("LOGIN", err instanceof LoginFileError ? err.code : "FILE");
      }
    }, (line) => log(line));
    // Unreachable with the probe hook set. Never keep a file.
    await download.discard().catch(() => undefined);
    stop = new ExportStop("PAGE", "PROBE_NOT_ATTACHED");
  } catch (err) {
    if (!(err instanceof ProbeDone)) {
      if (!(err instanceof ExportStop)) thrown = errorCode(err);
      stop = err instanceof ExportStop ? err : new ExportStop("PAGE", "STEP");
    }
  } finally {
    await exporter.close().catch(() => undefined);
  }

  const done = capture as NextWeekCapture | null;
  if (!stop && hooked && !done) stop = new ExportStop("PAGE", "DIALOG_OPEN");
  if (stop || !done) {
    const s = stop ?? new ExportStop("PAGE", "STEP");
    await log(`stop=${s.code}${s.reason ? ` reason=${s.reason}` : ""}${thrown ? ` ${thrown}` : ""}`);
    await log(`downloads=${downloads}`);
    await log(`end exit=${STOP_EXIT}`);
    return { exitCode: STOP_EXIT, stop: s.code, capture: null, downloads };
  }

  await log(`dialog before start=${d(done.before.start)} end=${d(done.before.end)} week=${weekOf(done.before, week, next)}`);
  for (const t of done.tries) {
    await log(
      `try field=${t.field} picker=${t.picker} route=${t.route} pages=${t.pages} result=${t.result} ` +
        `shows start=${d(t.shownAfter.start)} end=${d(t.shownAfter.end)}`,
    );
  }
  await log(`picker_opens=${done.pickerOpens}`);
  await log(`dialog after start=${d(done.after.start)} end=${d(done.after.end)} week=${weekOf(done.after, week, next)}`);
  await log(`reached=${done.reached ? "yes" : "no"}`);
  await log(`export_clicked=no downloads=${downloads}`);
  await log(`closed=${done.closed ? "yes" : "no"}`);
  const again = done.reopen;
  await log(
    again === "failed"
      ? "reopen=failed"
      : `reopen start=${d(again.start)} end=${d(again.end)} week=${weekOf(again, week, next)}`,
  );
  if (done.restore) {
    for (const t of done.restore.tries) {
      await log(
        `restore try field=${t.field} picker=${t.picker} route=${t.route} pages=${t.pages} result=${t.result} ` +
          `shows start=${d(t.shownAfter.start)} end=${d(t.shownAfter.end)}`,
      );
    }
    await log(`restore week=${done.restore.week}`);
  }
  for (const f of done.files) await log(`file=${f} mode=600`);
  // The profile is clear for the timer only when the dialog reopens (or is put back) on this week.
  const clear = weekOf(again, week, next) === "this" || done.restore?.week === "this";
  await log(`profile=${clear ? "clear" : "unchecked"}`);
  if (done.stepErrors.length > 0) await log(`step_errors=${done.stepErrors.join(",")}`);
  // Exit 6 only for a clean capture that reached next week with the profile clear.
  const reason = !clear ? "RESTORE" : done.stepErrors.length > 0 ? "STEP" : !done.reached ? "NOT_REACHED" : null;
  if (reason) {
    await log(`stop=PAGE reason=${reason}`);
    await log(`end exit=${STOP_EXIT}`);
    return { exitCode: STOP_EXIT, stop: "PAGE", capture: done, downloads };
  }
  await log(`end exit=${PROBE_EXIT}`);
  return { exitCode: PROBE_EXIT, stop: null, capture: done, downloads };
}
