/**
 * One timed run of the When I Work export (B2): sweep a leftover workbook,
 * export this Friday-through-Thursday, rename it into the import folder, run
 * the folder import in the job's mode (the timer writes apply), then delete the
 * workbook per the delete rule.
 *
 * The log gets one line per step: codes, counts and the file name. Never a
 * login field, a person's name, an Employee ID, an email or an error's text.
 */
import { appendFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  DIR_ENV,
  EXIT_CODES,
  formatSummary,
  MODE_ENV,
  runFolderImport,
  type FolderImportMode,
  type FolderImportResult,
} from "@/lib/import/folder-import";
import { LoginFileError, type WiwLogin } from "./login-file";
import { expectedDownloadName, exportWeekFor, importFileName, type ExportWeek } from "./week";

export const LOGIN_FILE_ENV = "WIW_LOGIN_FILE";
export const PROFILE_DIR_ENV = "WIW_BROWSER_PROFILE";

export type StopCode = "LOGIN" | "MFA" | "CAPTCHA" | "PAGE";

/** The export stopped at a screen it must not pass. The board keeps the last import. */
export class ExportStop extends Error {
  constructor(
    readonly code: StopCode,
    /** A fixed code such as a login-file check; never page or file text. */
    readonly reason?: string,
  ) {
    super(code);
    this.name = "ExportStop";
  }
}

/** Exit code for a stop (LOGIN, MFA, CAPTCHA, PAGE). The import codes 0/2/3/4 and error 1 pass through. */
export const STOP_EXIT = 5;

export type DownloadedExport = {
  /** The name When I Work gave the download. */
  suggestedName: string;
  saveAs(target: string): Promise<void>;
  discard(): Promise<void>;
};

export type ScheduleExporter = {
  /**
   * Download this week's export. Calls `login()` only when the sign-in page is
   * up. Throws ExportStop at a sign-in it cannot pass, a code, a CAPTCHA or a
   * page that does not match the steps. `note` takes fixed-code log lines only.
   */
  exportWeek(
    week: ExportWeek,
    login: () => Promise<WiwLogin>,
    note?: (line: string) => Promise<void>,
  ): Promise<DownloadedExport>;
  close(): Promise<void>;
};

export type WiwExportSettings = {
  appDir: string;
  importDir: string;
  loginFile: string;
  profileDir: string;
  logFile: string;
  /** apply: a changed day imports on its own. hold: it waits for a manager's Confirm. */
  importMode: FolderImportMode;
};

export class SettingsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SettingsError";
  }
}

function absoluteDir(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new SettingsError(`${key}_NOT_SET`);
  if (!path.isAbsolute(value)) throw new SettingsError(`${key}_NOT_ABSOLUTE`);
  return value;
}

/**
 * Settings from the environment. The import folder, login file and browser
 * folder have no default. The When I Work schedule is the authority (Rich,
 * 24 Sep): the timer sets FLOOR_BOARDS_IMPORT_MODE=apply, so a changed day
 * imports with no Confirm. Unset stays hold, so a hand run changes no day
 * already on the board. Any other value refuses.
 */
export function wiwSettingsFromEnv(
  appDir: string,
  env: Record<string, string | undefined> = process.env,
): WiwExportSettings {
  const mode = (env[MODE_ENV] ?? "").trim().toLowerCase();
  if (mode !== "" && mode !== "hold" && mode !== "apply") {
    throw new SettingsError(`${MODE_ENV}_NOT_HOLD_OR_APPLY`);
  }
  return {
    appDir,
    importDir: absoluteDir(env, DIR_ENV),
    loginFile: absoluteDir(env, LOGIN_FILE_ENV),
    profileDir: absoluteDir(env, PROFILE_DIR_ENV),
    logFile: path.join(appDir, "var", "log", "wiw-export.log"),
    importMode: mode === "apply" ? "apply" : "hold",
  };
}

const EXPORT_NAME = /^Schedule_for_.+\.(xlsx|csv)$/i;
const PART_PREFIX = ".wiw-export-";

export type WiwExportResult = {
  exitCode: number;
  stop: StopCode | null;
  importResult: FolderImportResult | null;
  /** Whether the workbook this run saved is gone at the end of the run. */
  workbookDeleted: boolean;
};

export type WiwExportDeps = {
  exporter: ScheduleExporter;
  readLogin: () => Promise<WiwLogin>;
  runImport?: (dir: string, now: Date) => Promise<FolderImportResult>;
  now?: () => Date;
  /** Appends one log line. Tests wrap it to see the folder at the moment each line is written. */
  appendLog?: (file: string, text: string) => Promise<void>;
};

async function removeIfFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  await rm(file, { force: true });
  return true;
}

/**
 * A workbook a held (hold-mode) run left for Confirm is deleted at the next
 * run, as is a half-saved download. Only this job's names: `Schedule_for_*` and its own
 * hidden part files.
 */
async function sweepLeftovers(dir: string): Promise<number> {
  let n = 0;
  for (const name of await readdir(dir)) {
    if (EXPORT_NAME.test(name) || name.startsWith(PART_PREFIX)) {
      if (await removeIfFile(path.join(dir, name))) n += 1;
    }
  }
  return n;
}

/** Delete rule per import outcome: held (hold mode only) waits for Confirm; everything else goes now. */
export function keepsWorkbook(result: FolderImportResult | null): boolean {
  return result?.outcome === "held";
}

export async function runWiwExport(
  settings: WiwExportSettings,
  deps: WiwExportDeps,
): Promise<WiwExportResult> {
  const now = deps.now ?? (() => new Date());
  await mkdir(path.dirname(settings.logFile), { recursive: true });
  const log = async (line: string) => {
    await (deps.appendLog ?? appendFile)(settings.logFile, `${now().toISOString()} wiw-export ${line}\n`);
  };

  const week = exportWeekFor(now());
  const target = path.join(settings.importDir, importFileName(week));
  await log(`start week=${week.friday}..${week.thursday}`);

  const finish = async (r: WiwExportResult) => {
    await log(`end exit=${r.exitCode} workbook=${r.workbookDeleted ? "deleted" : "kept"}`);
    return r;
  };

  let saved = false;
  try {
    const swept = await sweepLeftovers(settings.importDir);
    if (swept > 0) await log(`leftover deleted=${swept}`);

    // The browser stays open until the download is saved: closing it deletes the download.
    try {
      let download: DownloadedExport;
      try {
        download = await deps.exporter.exportWeek(week, async () => {
          try {
            return await deps.readLogin();
          } catch (err) {
            throw new ExportStop("LOGIN", err instanceof LoginFileError ? err.code : "FILE");
          }
        }, log);
      } catch (err) {
        // A step that threw without a stop code is still a page that did not match.
        const stop = err instanceof ExportStop ? err : new ExportStop("PAGE", "STEP");
        await log(`stop=${stop.code}${stop.reason ? ` reason=${stop.reason}` : ""}`);
        return await finish({ exitCode: STOP_EXIT, stop: stop.code, importResult: null, workbookDeleted: true });
      }

      if (download.suggestedName !== expectedDownloadName(week)) {
        await download.discard().catch(() => undefined);
        await log("stop=PAGE reason=DOWNLOAD_NAME");
        return await finish({ exitCode: STOP_EXIT, stop: "PAGE", importResult: null, workbookDeleted: true });
      }

      // Save under a hidden name first, so the import never reads a half-written file.
      const part = path.join(settings.importDir, `${PART_PREFIX}${process.pid}.part`);
      await download.saveAs(part);
      await download.discard().catch(() => undefined);
      await rename(part, target);
      saved = true;
      await log(`saved file=${path.basename(target)}`);
    } finally {
      await deps.exporter.close().catch(() => undefined);
    }

    const runImport =
      deps.runImport ?? ((dir: string, at: Date) => runFolderImport({ dir, mode: settings.importMode }, { now: at }));
    let result: FolderImportResult;
    try {
      result = await runImport(settings.importDir, now());
    } catch {
      await log("import error=IMPORT");
      const deleted = await removeIfFile(target);
      return await finish({ exitCode: 1, stop: null, importResult: null, workbookDeleted: deleted });
    }
    for (const line of formatSummary(result)) await log(`import ${line}`);

    const keep = keepsWorkbook(result);
    if (!keep) await removeIfFile(target);
    return await finish({
      exitCode: EXIT_CODES[result.outcome],
      stop: null,
      importResult: result,
      workbookDeleted: !keep,
    });
  } catch {
    // Folder or log trouble. Log the code only, then take the workbook away.
    await log("error=RUN").catch(() => undefined);
    const deleted = saved ? await removeIfFile(target).catch(() => false) : true;
    await sweepPart(settings.importDir).catch(() => undefined);
    const r: WiwExportResult = { exitCode: 1, stop: null, importResult: null, workbookDeleted: deleted };
    return await finish(r).catch(() => r);
  }
}

async function sweepPart(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (name.startsWith(PART_PREFIX)) await removeIfFile(path.join(dir, name));
  }
}
