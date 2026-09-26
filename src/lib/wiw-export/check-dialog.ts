/**
 * Check-only mode for the When I Work export (B2): which week does the export
 * dialog open on in the timer's browser folder? Run before the 07:00 export
 * after a probe left that folder unchecked.
 *
 * Same steps as a run up to the dialog wait (sign-in and menu unchanged).
 * Then it reads the Start and End buttons, closes the dialog with its close
 * button (Escape only if it is still up), and logs
 * `week=this|next|other|failed`. It clicks no date button, no picker and no
 * day, and never the dialog's Export. The browser runs with downloads
 * refused. Nothing goes to the import folder, no import runs, no timer is
 * written or loaded, and no file is written besides the log.
 *
 * Each action logs `step=<name>` first and has a 5-second timeout. A throw
 * logs `step_error=<name> error=<class> call=<api>`: never the message text,
 * which can quote the page.
 *
 * Exit 6 when the dialog opens on this week (the timer's check will pass),
 * 5 for anything else, 1 error.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { dialogControls, exportDialog, ProbeDone } from "./browser";
import { LoginFileError, type WiwLogin } from "./login-file";
import { PROBE_EXIT } from "./probe";
import { weekOf, type Shown } from "./probe-next-week";
import { ExportStop, STOP_EXIT, type ScheduleExporter, type StopCode, type WiwExportSettings } from "./run";
import { exportWeekFor, followingWeek } from "./week";

const SHOWN_DATE = /\b\d{2}\/\d{2}\/\d{4}\b/g;

/**
 * The error's class and the Playwright call that threw ("locator.click"), from
 * the head of its message. Never the rest of the message.
 */
export function errorCode(err: unknown): string {
  const cls = err instanceof Error ? err.name.replace(/[^A-Za-z]/g, "") || "Error" : "Unknown";
  const call = err instanceof Error ? /^([A-Za-z]+\.[A-Za-z]+):/.exec(err.message)?.[1] : undefined;
  return `error=${cls} call=${call ?? "-"}`;
}

/** The one MM/dd/yyyy date a date button shows. Reads text only; never clicks. */
async function shownDate(button: Locator): Promise<string | null> {
  if ((await button.count()) !== 1) return null;
  const text = (await button.innerText()) || ((await button.getAttribute("value")) ?? "");
  const found = text.match(SHOWN_DATE) ?? [];
  return found.length === 1 ? found[0]! : null;
}

export type CheckResult = {
  exitCode: number;
  stop: StopCode | null;
  shown: Shown | null;
  week: string;
  downloads: number;
};

export type CheckDeps = {
  /** Built with `probe` set and downloads refused; the check is attached as the probe hook. */
  exporter: (probe: (page: Page) => Promise<void>) => ScheduleExporter;
  readLogin: () => Promise<WiwLogin>;
  now?: () => Date;
  actionTimeoutMs?: number;
};

export async function runCheckDialog(settings: WiwExportSettings, deps: CheckDeps): Promise<CheckResult> {
  const now = deps.now ?? (() => new Date());
  await mkdir(path.dirname(settings.logFile), { recursive: true });
  const log = (line: string) => appendFile(settings.logFile, `${now().toISOString()} wiw-export check-dialog ${line}\n`);
  const week = exportWeekFor(now());
  const next = followingWeek(week);
  await log(`start this=${week.friday}..${week.thursday}`);

  let downloads = 0;
  let shown: Shown | null = null;
  let failedStep: string | null = null;

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    await log(`step=${name}`);
    try {
      return await fn();
    } catch (err) {
      failedStep = failedStep ?? name;
      await log(`step_error=${name} ${errorCode(err)}`);
      throw err;
    }
  };

  const exporter = deps.exporter(async (page) => {
    page.on("download", (dl) => void ((downloads += 1), dl.cancel().catch(() => undefined)));
    page.setDefaultTimeout(deps.actionTimeoutMs ?? 5_000);
    const dialog = exportDialog(page);
    if ((await dialog.count()) === 0) {
      failedStep = "dialog.open";
      await log("step_error=dialog.open error=NoDialog call=-");
      return;
    }
    const box = dialog.first();
    const c = dialogControls(box);
    try {
      shown = await step("dialog.read", async () => ({ start: await shownDate(c.start), end: await shownDate(c.end) }));
    } catch {
      // Logged; still close.
    }
    await step("close", async () => {
      const close = box.getByRole("button", { name: "close", exact: true });
      if ((await close.count()) === 1 && (await close.isVisible())) await close.click();
      if (await box.isVisible()) await page.keyboard.press("Escape");
      await box.waitFor({ state: "hidden" });
    }).catch(() => undefined);
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
    // Unreachable with the hook set. Never keep a file.
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

  const read = shown as Shown | null;
  const found = read ? weekOf(read, week, next) : "failed";
  if (read) await log(`dialog start=${read.start ?? "-"} end=${read.end ?? "-"}`);
  await log(`week=${found}`);
  await log(`export_clicked=no downloads=${downloads}`);
  if (stop) {
    await log(`stop=${stop.code}${stop.reason ? ` reason=${stop.reason}` : ""}${thrown ? ` ${thrown}` : ""}`);
  } else if (found !== "this") {
    await log(`stop=PAGE reason=${failedStep === "dialog.open" ? "DIALOG_OPEN" : found === "failed" ? "STEP" : "WEEK"}`);
  }
  const ok = !stop && found === "this";
  await log(`end exit=${ok ? PROBE_EXIT : STOP_EXIT}`);
  return { exitCode: ok ? PROBE_EXIT : STOP_EXIT, stop: stop?.code ?? (ok ? null : "PAGE"), shown: read, week: found, downloads };
}
