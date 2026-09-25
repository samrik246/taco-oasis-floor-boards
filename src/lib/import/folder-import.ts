/**
 * Import from a folder (C2). Picks the newest When I Work export
 * (`Schedule_for_*.xlsx` or `.csv`) in one folder and runs it through the C1
 * path only: `previewImport`, then `commitImport` with the preview's
 * fingerprint and plan digest. It never writes shifts, employees or
 * assignments any other way.
 *
 * Mode `hold` (default): a file whose dates are all new imports in one step,
 * exactly like the upload screen. A file that changes an imported day is left
 * for a manager to preview and Confirm on the upload screen; nothing is
 * written. Mode `apply`: that preview is confirmed by the job itself.
 *
 * The summary carries counts, the file name and codes. Never a person's name,
 * Employee ID or email.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { parseScheduleWorkbook, type ParseResult } from "@/lib/parser/schedule-parser";
import {
  commitImport,
  ImportRefusedError,
  previewImport,
} from "@/lib/import/persist-import";
import type { DatePreview } from "@/lib/import/reconcile";
import { TIMEZONE } from "@/lib/constants";

export type FolderImportMode = "hold" | "apply";

export type FolderImportSettings = {
  dir: string;
  mode: FolderImportMode;
};

export type DateCounts = Omit<DatePreview, "assignmentsToRemove" | "assignmentsToTransfer"> & {
  assignmentsToRemove: number;
  assignmentsToTransfer: number;
};

export type FolderImportOutcome =
  | "imported"
  | "held"
  | "refused"
  | "no-file";

export type FolderImportResult = {
  outcome: FolderImportOutcome;
  mode: FolderImportMode;
  file: string | null;
  /** DUPLICATE, EMPTY, WRONG_WEEK, BOARD_CHANGED, REFUSED, UNREADABLE, ... */
  code: string | null;
  rowCount: number;
  dates: DateCounts[];
  /** Refusal codes and how many of each; never the refusal text (it names Employee IDs). */
  refusals: Record<string, number>;
};

/** Exit code per outcome, for whoever runs the command. */
export const EXIT_CODES: Record<FolderImportOutcome, number> = {
  imported: 0,
  held: 2,
  refused: 3,
  "no-file": 4,
};

const EXPORT_NAME = /^Schedule_for_.+\.(xlsx|csv)$/i;

export const MODE_ENV = "FLOOR_BOARDS_IMPORT_MODE";
export const DIR_ENV = "FLOOR_BOARDS_IMPORT_DIR";

/** Read settings from the environment. The folder has no default; mode defaults to hold. */
export function settingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): FolderImportSettings {
  const dir = env[DIR_ENV]?.trim();
  if (!dir) throw new Error(`${DIR_ENV} is not set. Set it to the folder the exports are dropped in.`);
  if (!path.isAbsolute(dir)) throw new Error(`${DIR_ENV} must be an absolute path.`);
  const raw = (env[MODE_ENV] ?? "").trim().toLowerCase();
  if (raw !== "" && raw !== "hold" && raw !== "apply") {
    throw new Error(`${MODE_ENV} must be "hold" or "apply".`);
  }
  return { dir, mode: raw === "apply" ? "apply" : "hold" };
}

/** Restaurant calendar date (America/Chicago) for an instant. */
export function restaurantDate(now: Date): string {
  return formatInTimeZone(now, TIMEZONE, "yyyy-MM-dd");
}

/** Newest export by modified time; ties go to the later name. Hidden files are ignored. */
export async function newestExport(dir: string): Promise<string | null> {
  const names = (await readdir(dir)).filter((n) => !n.startsWith(".") && EXPORT_NAME.test(n));
  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const info = await stat(path.join(dir, name));
    if (!info.isFile()) continue;
    if (
      !best ||
      info.mtimeMs > best.mtimeMs ||
      (info.mtimeMs === best.mtimeMs && name > best.name)
    ) {
      best = { name, mtimeMs: info.mtimeMs };
    }
  }
  return best ? path.join(dir, best.name) : null;
}

/**
 * An update is about the current schedule: the file's first and last dates
 * (shifts and open shifts) must bracket the restaurant's date today.
 */
function coversToday(parsed: ParseResult, today: string): boolean {
  const dates = [...parsed.dates, ...Object.keys(parsed.skippedOpenShifts ?? {})].sort();
  if (dates.length === 0) return false;
  return dates[0]! <= today && today <= dates[dates.length - 1]!;
}

function counts(dates: DatePreview[]): DateCounts[] {
  return dates.map((d) => ({ ...d, assignmentsToRemove: d.assignmentsToRemove.length,
    assignmentsToTransfer: d.assignmentsToTransfer.length }));
}

function tally(codes: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of codes) out[c] = (out[c] ?? 0) + 1;
  return out;
}

export async function runFolderImport(
  settings: FolderImportSettings,
  opts: { now?: Date } = {},
): Promise<FolderImportResult> {
  const now = opts.now ?? new Date();
  const base = { mode: settings.mode, rowCount: 0, dates: [], refusals: {} };

  const file = await newestExport(settings.dir);
  if (!file) return { ...base, outcome: "no-file", file: null, code: null };
  const name = path.basename(file);
  const refused = (code: string, extra: Partial<FolderImportResult> = {}): FolderImportResult => ({
    ...base,
    outcome: "refused",
    file: name,
    code,
    ...extra,
  });

  let parsed: ParseResult;
  try {
    parsed = await parseScheduleWorkbook(await readFile(file), { filename: name });
  } catch {
    // Parser messages can quote a cell; report the code only.
    return refused("UNREADABLE");
  }
  if (parsed.shifts.length === 0) return refused("EMPTY");
  if (!coversToday(parsed, restaurantDate(now))) {
    return refused("WRONG_WEEK", { rowCount: parsed.shifts.length });
  }

  try {
    const preview = await previewImport(parsed, { now });
    const shown = { rowCount: preview.rowCount, dates: counts(preview.dates) };
    if (preview.refusals.length > 0) {
      return refused("REFUSED", { ...shown, refusals: tally(preview.refusals.map((r) => r.code)) });
    }
    if (preview.needsConfirm && settings.mode === "hold") {
      return { ...base, ...shown, outcome: "held", file: name, code: "NEEDS_CONFIRM" };
    }
    const result = await commitImport(parsed, name, {
      now,
      expected: preview.needsConfirm
        ? { fingerprint: preview.fingerprint, planDigest: preview.planDigest }
        : undefined,
    });
    return {
      ...base,
      outcome: "imported",
      file: name,
      code: null,
      rowCount: result.rowCount,
      dates: counts(result.dates),
    };
  } catch (err) {
    if (err instanceof ImportRefusedError) {
      return refused(err.code, {
        rowCount: parsed.shifts.length,
        refusals: tally(err.refusals.map((r) => r.code)),
      });
    }
    throw err;
  }
}

/** Output lines: counts, codes and the file name only. */
export function formatSummary(r: FolderImportResult): string[] {
  const lines = [
    `outcome=${r.outcome} mode=${r.mode} code=${r.code ?? "-"} file=${r.file ?? "-"} rows=${r.rowCount}`,
  ];
  for (const d of r.dates) {
    lines.push(
      `date=${d.date} added=${d.added} changed=${d.changed} replaced=${d.replaced} unchanged=${d.unchanged} removed=${d.removed} openShiftsSkipped=${d.skippedOpenShifts} assignmentsKept=${d.assignmentsKept} assignmentsRemoved=${d.assignmentsToRemove} assignmentsTransferred=${d.assignmentsToTransfer}`,
    );
  }
  for (const [code, n] of Object.entries(r.refusals)) lines.push(`refusal=${code} count=${n}`);
  if (r.outcome === "held") {
    lines.push("A manager must upload this file on the upload screen, check the preview and Confirm.");
  }
  return lines;
}
