/**
 * The next-week browser step (B2 lane 2): the date moves the next-week probe
 * makes, used by the export.
 *
 * `set` moves the open Export Schedule dialog to the following Friday through
 * Thursday with the date pickers: End before Start when moving later (When I
 * Work disables Start days after End), a day clicked in the calendar or a date
 * typed and committed with Tab, never Enter. Any step error stops with
 * `PAGE NEXT_DATE`; the export's own date check then refuses anything but the
 * exact week (`DIALOG_DATE`).
 *
 * `restore` runs after the export, whatever happened: close the dialog, reload
 * the scheduler, reopen the dialog and read its week. Not this week: set this
 * week back the same way and read once more. The log ends `restore week=this`
 * or, when it could not be put back, `restore week=<other|next|failed>`; the
 * next timer run then stops on `DIALOG_DATE` rather than exporting a wrong week.
 *
 * No screenshots, snapshots or page text: only step codes and the dates the
 * buttons show go to the log.
 */
import type { Locator, Page } from "@playwright/test";
import { exportDialog, type NextWeekDialog } from "./browser";
import { ExportStop } from "./run";
import { readShown, reopen, reopenAndRead, safeClose, setWeek, weekOf, type Steps } from "./probe-next-week";
import { followingWeek, type ExportWeek } from "./week";

export type NextWeekDialogOptions = {
  /** Per-action wait inside the dialog. */
  actionTimeoutMs?: number;
  /** Wait for the scheduler and menu on reopen. */
  stepTimeoutMs?: number;
  menuSettleMs?: number;
};

const d = (s: string | null) => s ?? "-";

export function nextWeekDialog(opts: NextWeekDialogOptions = {}): NextWeekDialog {
  const action = opts.actionTimeoutMs ?? 5_000;
  const step = opts.stepTimeoutMs ?? 30_000;
  const settle = opts.menuSettleMs ?? 800;
  const stepsFor = (note?: (line: string) => Promise<void>): Steps => ({
    log: note ?? (async () => undefined),
    errors: [],
  });

  return {
    async set(page: Page, box: Locator, week: ExportWeek, note) {
      const steps = stepsFor(note);
      // A stuck control fails in seconds; the export's own waits are explicit.
      page.setDefaultTimeout(action);
      const tries = await setWeek(page, box, week, null, { pickerOpens: 0 }, steps);
      for (const t of tries) {
        await steps.log(`date field=${t.field} route=${t.route} pages=${t.pages} result=${t.result}`);
      }
      const shown = await readShown(box).catch(() => ({ start: null, end: null }));
      await steps.log(`dialog start=${d(shown.start)} end=${d(shown.end)}`);
      if (steps.errors.length > 0 || tries.some((t) => t.result !== "set")) throw new ExportStop("PAGE", "NEXT_DATE");
    },

    async restore(page: Page, thisWeek: ExportWeek, note) {
      const steps = stepsFor(note);
      try {
        page.setDefaultTimeout(action);
        const open = exportDialog(page);
        if (await open.first().isVisible().catch(() => false)) await safeClose(page, open.first(), steps);
        const next = followingWeek(thisWeek);
        let shown = await reopenAndRead(page, step, settle, steps);
        if (weekOf(shown, thisWeek, next) !== "this") {
          const box = await reopen(page, step, settle, steps);
          if (box) {
            await setWeek(page, box, thisWeek, null, { pickerOpens: 0 }, steps, "restore-");
            if (await box.isVisible().catch(() => false)) await safeClose(page, box, steps);
          }
          shown = await reopenAndRead(page, step, settle, steps);
        }
        await steps.log(`restore week=${weekOf(shown, thisWeek, next)}`);
      } catch {
        await steps.log("restore week=failed").catch(() => undefined);
      }
    },
  };
}
