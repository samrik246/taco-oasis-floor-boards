/**
 * Probe mode for the When I Work export (B2): the same steps as a run up to
 * the Export Schedule click, then a capture of what opened. Used to write the
 * dialog selectors from the live page instead of from memory.
 *
 * The capture is the ARIA snapshot of the visible dialog (or of the whole
 * page if no dialog shows), written to var/log with mode 600. It holds page
 * text and field values, so it stays on the Mac. The log gets counts, and the
 * role and name of each textbox, combobox, checkbox and button; never a field
 * value. Without a dialog, names are logged only for export-shaped controls
 * (a scheduler page has buttons named after people); the rest are counted.
 *
 * The dialog's Export button is never clicked, nothing is saved to the import
 * folder, no import runs and no timer is written or loaded.
 */
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { ProbeDone } from "./browser";
import { LoginFileError, type WiwLogin } from "./login-file";
import { ExportStop, STOP_EXIT, type ScheduleExporter, type StopCode, type WiwExportSettings } from "./run";
import { exportWeekFor } from "./week";

/** A probe that captured the page. Never 0, so a probe never reads as an import. */
export const PROBE_EXIT = 6;

type ControlRole = "textbox" | "combobox" | "checkbox" | "button";

/** Whole-page fallback: only these names are logged. */
const EXPORT_SHAPED = /\b(export|start|end|dates?|split|separate|schedules?|cancel|close|download|range|format)\b/i;

export type ProbeControl = { role: ControlRole; name: string | null; state: string | null };

export type ProbeCapture = {
  dialogs: number;
  visibleDialogs: number;
  scope: "dialog" | "page";
  /** Visible matches for the f1d603a dialog locators: which DIALOG check would fail. */
  startLabel: number;
  endLabel: number;
  exportButton: number;
  snapshot: string;
};

export type ProbeResult = { exitCode: number; stop: StopCode | null; snapshotFile: string | null };

const LINE = /^\s*- (textbox|combobox|checkbox|button)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)/;

/** Role, name and state of each control in an ARIA snapshot. Drops the `: value` part. */
export function controlsOf(snapshot: string): ProbeControl[] {
  const out: ProbeControl[] = [];
  for (const line of snapshot.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const state = m[3]?.trim() || null;
    out.push({ role: m[1] as ControlRole, name: m[2] === undefined ? null : m[2].replace(/\\(.)/g, "$1"), state });
  }
  return out;
}

async function visibleCount(l: Locator): Promise<number> {
  let n = 0;
  for (const item of await l.all()) if (await item.isVisible().catch(() => false)) n += 1;
  return n;
}

/** Wait for a dialog after the Export Schedule click, then capture it (or the page). */
export async function captureDialog(page: Page, timeoutMs: number): Promise<ProbeCapture> {
  const dialog = page.getByRole("dialog").or(page.getByRole("alertdialog"));
  const shown = await dialog
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  const dialogs = await dialog.count();
  const visibleDialogs = await visibleCount(dialog);
  let scope: Locator = page.locator("body");
  if (shown && visibleDialogs > 0) {
    for (const item of await dialog.all()) {
      if (await item.isVisible().catch(() => false)) {
        scope = item;
        break;
      }
    }
  }
  return {
    dialogs,
    visibleDialogs,
    scope: shown && visibleDialogs > 0 ? "dialog" : "page",
    startLabel: await visibleCount(scope.getByLabel(/start date/i)),
    endLabel: await visibleCount(scope.getByLabel(/end date/i)),
    exportButton: await visibleCount(scope.getByRole("button", { name: /^export$/i })),
    snapshot: await scope.ariaSnapshot(),
  };
}

function controlLines(capture: ProbeCapture): string[] {
  const lines: string[] = [];
  let hidden = 0;
  for (const c of controlsOf(capture.snapshot)) {
    if (capture.scope === "page" && !(c.name && EXPORT_SHAPED.test(c.name))) {
      hidden += 1;
      continue;
    }
    const name = c.name === null ? "-" : JSON.stringify(c.name.replace(/\s+/g, " ").slice(0, 80));
    lines.push(`probe control role=${c.role} name=${name}${c.state ? ` state=${c.state.replace(/\s+/g, "")}` : ""}`);
  }
  if (capture.scope === "page") lines.push(`probe control other=${hidden}`);
  return lines;
}

export type ProbeDeps = {
  /** Built with `probe` set; the probe hook is attached here. */
  exporter: (probe: (page: Page, step: number) => Promise<void>) => ScheduleExporter;
  readLogin: () => Promise<WiwLogin>;
  now?: () => Date;
};

export async function runProbeDialog(settings: WiwExportSettings, deps: ProbeDeps): Promise<ProbeResult> {
  const now = deps.now ?? (() => new Date());
  const logDir = path.dirname(settings.logFile);
  await mkdir(logDir, { recursive: true });
  const log = (line: string) => appendFile(settings.logFile, `${now().toISOString()} wiw-export ${line}\n`);
  const week = exportWeekFor(now());
  await log(`probe start week=${week.friday}..${week.thursday}`);

  let capture: ProbeCapture | null = null;
  const exporter = deps.exporter(async (page, step) => {
    capture = await captureDialog(page, step);
  });

  let stop: ExportStop | null = null;
  try {
    const download = await exporter.exportWeek(week, async () => {
      try {
        return await deps.readLogin();
      } catch (err) {
        throw new ExportStop("LOGIN", err instanceof LoginFileError ? err.code : "FILE");
      }
    });
    // Unreachable with the probe hook set. Never keep a file.
    await download.discard().catch(() => undefined);
    stop = new ExportStop("PAGE", "PROBE_NOT_ATTACHED");
  } catch (err) {
    if (!(err instanceof ProbeDone)) stop = err instanceof ExportStop ? err : new ExportStop("PAGE", "STEP");
  } finally {
    await exporter.close().catch(() => undefined);
  }

  const done = capture as ProbeCapture | null;
  if (stop || !done) {
    const s = stop ?? new ExportStop("PAGE", "STEP");
    await log(`probe stop=${s.code}${s.reason ? ` reason=${s.reason}` : ""}`);
    await log(`probe end exit=${STOP_EXIT}`);
    return { exitCode: STOP_EXIT, stop: s.code, snapshotFile: null };
  }

  const file = path.join(logDir, `wiw-probe-${now().toISOString().replace(/[:.]/g, "-")}.aria.yml`);
  await writeFile(file, `${done.snapshot}\n`, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  await log(
    `probe dialogs=${done.dialogs} visible=${done.visibleDialogs} scope=${done.scope} ` +
      `start_label=${done.startLabel} end_label=${done.endLabel} export_button=${done.exportButton}`,
  );
  for (const line of controlLines(done)) await log(line);
  await log(`probe snapshot file=${path.basename(file)} mode=600`);
  await log(`probe end exit=${PROBE_EXIT}`);
  return { exitCode: PROBE_EXIT, stop: null, snapshotFile: file };
}
