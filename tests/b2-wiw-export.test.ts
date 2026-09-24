import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import type { FolderImportResult } from "@/lib/import/folder-import";
import { launchAgentPlist, WIW_EXPORT_LABEL } from "@/lib/wiw-export/launch-agent";
import {
  LoginFileError,
  parseLoginFile,
  readLoginFile,
} from "@/lib/wiw-export/login-file";
import {
  ExportStop,
  runWiwExport,
  STOP_EXIT,
  wiwSettingsFromEnv,
  type DownloadedExport,
  type ScheduleExporter,
  type StopCode,
  type WiwExportSettings,
} from "@/lib/wiw-export/run";
import {
  dialogDate,
  expectedDownloadName,
  exportWeekFor,
  importFileName,
} from "@/lib/wiw-export/week";
import { chicagoDateTime } from "@/lib/time";
import { resetScheduleTables, syntheticXlsx, type SyntheticRow } from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();

/** Monday. Its Friday-through-Thursday is 2030-05-31 .. 2030-06-06. */
const D = "2030-06-03";
const MORNING_RUN = chicagoDateTime(D, "7:00 am");
const AFTERNOON_RUN = chicagoDateTime(D, "4:00 pm");
const WEEK = { friday: "2030-05-31", thursday: "2030-06-06" };
const TARGET = "Schedule_for_2030-05-31_2030-06-06.xlsx";
const WIW_NAME = "Schedule for May 31, 2030 - Jun 6, 2030.xlsx";

/** Values that must never appear in a log, an error or console output. */
const SECRET_EMAIL = "sentinel-login-7q2x@example.invalid";
const SECRET_PASSWORD = "Sentinel-Pass-9Zk!w";

const r = (employeeId: string, firstName: string, start: string, end: string, date = D): SyntheticRow => ({
  position: "Caja - Regular",
  firstName,
  lastName: "Ejemplo",
  employeeId,
  date,
  start,
  end,
});

const MORNING = [r("7301", "Abril", "8:00 am", "4:00 pm"), r("7302", "Bruno", "9:00 am", "7:00 pm")];
const AFTERNOON = [r("7301", "Abril", "8:00 am", "4:00 pm"), r("7302", "Bruno", "9:00 am", "3:00 pm")];

let root: string;
let settings: WiwExportSettings;

type FakeExport = {
  body?: Buffer;
  name?: string;
  stop?: StopCode;
  throws?: boolean;
  signIn?: boolean;
};

type FakeExporter = ScheduleExporter & {
  calls: number;
  closed: number;
  discarded: number;
  typed: Array<{ email: string; password: string }>;
};

function fakeExporter(plan: FakeExport): FakeExporter {
  const ex: FakeExporter = {
    calls: 0,
    closed: 0,
    discarded: 0,
    typed: [],
    async exportWeek(_week, login): Promise<DownloadedExport> {
      ex.calls += 1;
      if (plan.signIn) ex.typed.push((await login()).reveal());
      if (plan.stop) throw new ExportStop(plan.stop);
      if (plan.throws) throw new Error(`locator timed out near ${SECRET_EMAIL}`);
      return {
        suggestedName: plan.name ?? WIW_NAME,
        saveAs: (target) => writeFile(target, plan.body ?? Buffer.from("")),
        discard: async () => {
          ex.discarded += 1;
        },
      };
    },
    async close() {
      ex.closed += 1;
    },
  };
  return ex;
}

async function writeLoginFile(body: string, mode = 0o600): Promise<string> {
  const file = path.join(root, "secrets", "wiw-login");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, mode);
  return file;
}

const readLogin = () =>
  readLoginFile(settings.loginFile, {
    keepOut: [settings.appDir, settings.importDir, settings.profileDir],
  });

async function run(ex: ScheduleExporter, at: Date, extra: { runImport?: typeof fakeImportThrows } = {}) {
  return runWiwExport(settings, { exporter: ex, readLogin, now: () => at, ...extra });
}

async function fakeImportThrows(): Promise<FolderImportResult> {
  throw new Error(`database locked for ${SECRET_EMAIL}`);
}

async function logText(): Promise<string> {
  return readFile(settings.logFile, "utf8").catch(() => "");
}

async function folder(): Promise<string[]> {
  return (await readdir(settings.importDir)).sort();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "b2-wiw-export-"));
  const appDir = path.join(root, "app");
  settings = {
    appDir,
    importDir: path.join(root, "exports"),
    profileDir: path.join(root, "browser"),
    loginFile: path.join(root, "secrets", "wiw-login"),
    logFile: path.join(appDir, "var", "log", "wiw-export.log"),
  };
  await mkdir(settings.importDir, { recursive: true });
  await mkdir(settings.profileDir, { recursive: true });
  await writeLoginFile(`email=${SECRET_EMAIL}\npassword=${SECRET_PASSWORD}\n`);
  await resetScheduleTables(prisma);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("B2 export week and names", () => {
  it("takes the Friday through Thursday that contains today in Chicago, every day of the week", () => {
    const days = ["2030-05-31", "2030-06-01", "2030-06-02", "2030-06-03", "2030-06-04", "2030-06-05", "2030-06-06"];
    for (const day of days) {
      expect(exportWeekFor(chicagoDateTime(day, "7:00 am"))).toEqual(WEEK);
      expect(exportWeekFor(chicagoDateTime(day, "4:00 pm"))).toEqual(WEEK);
    }
    // Friday is a new week; Thursday night is still the old one.
    expect(exportWeekFor(chicagoDateTime("2030-06-07", "7:00 am"))).toEqual({
      friday: "2030-06-07",
      thursday: "2030-06-13",
    });
    // 03:30 UTC Friday is still Thursday evening in Chicago.
    expect(exportWeekFor(new Date("2030-06-07T03:30:00Z"))).toEqual(WEEK);
  });

  it("differs from the payroll ISO-Monday rule on a Saturday", () => {
    // ISO Monday of Sat 2026-09-26 is 2026-09-21; minus 3 is Fri 2026-09-18, which ends before Saturday.
    expect(exportWeekFor(chicagoDateTime("2026-09-26", "7:00 am"))).toEqual({
      friday: "2026-09-25",
      thursday: "2026-10-01",
    });
  });

  it("names the file the folder import reads, and the name When I Work gives the download", () => {
    expect(importFileName(WEEK)).toBe(TARGET);
    expect(TARGET).toMatch(/^Schedule_for_.+\.(xlsx|csv)$/i);
    expect(expectedDownloadName(WEEK)).toBe(WIW_NAME);
    // The two names on record from real downloads (week 2632 and week 2638).
    expect(expectedDownloadName({ friday: "2026-07-31", thursday: "2026-08-06" })).toBe(
      "Schedule for Jul 31, 2026 - Aug 6, 2026.xlsx",
    );
    expect(expectedDownloadName({ friday: "2026-09-11", thursday: "2026-09-17" })).toBe(
      "Schedule for Sep 11, 2026 - Sep 17, 2026.xlsx",
    );
    expect(dialogDate("2030-05-31")).toBe("05/31/2030");
  });
});

describe("B2 delete rule per exit code", () => {
  it("exit 0 imported: new days on the board, workbook deleted in the same run", async () => {
    const ex = fakeExporter({ body: await syntheticXlsx(MORNING) });
    const res = await run(ex, MORNING_RUN);
    expect(res).toMatchObject({ exitCode: 0, stop: null, workbookDeleted: true });
    expect(res.importResult?.outcome).toBe("imported");
    expect(await prisma.shift.count()).toBe(2);
    expect(await folder()).toEqual([]);
    expect(ex.closed).toBe(1);
    const log = await logText();
    expect(log).toContain(`saved file=${TARGET}`);
    expect(log).toContain("import outcome=imported mode=hold");
    expect(log).toContain("end exit=0 workbook=deleted");
  });

  it("exit 2 held: an afternoon change waits for Confirm, the workbook stays, the next run deletes it", async () => {
    await run(fakeExporter({ body: await syntheticXlsx(MORNING) }), MORNING_RUN);
    const shiftsBefore = await prisma.shift.findMany({ orderBy: { id: "asc" } });

    const held = await run(fakeExporter({ body: await syntheticXlsx(AFTERNOON) }), AFTERNOON_RUN);
    expect(held).toMatchObject({ exitCode: 2, workbookDeleted: false });
    expect(held.importResult).toMatchObject({ outcome: "held", code: "NEEDS_CONFIRM", mode: "hold" });
    expect(await folder()).toEqual([TARGET]);
    // Never auto-confirmed: the board is unchanged.
    expect(await prisma.shift.findMany({ orderBy: { id: "asc" } })).toEqual(shiftsBefore);
    expect(await logText()).toContain("end exit=2 workbook=kept");

    // Nobody confirmed. The next run deletes the leftover first, even when it then stops.
    const next = await run(fakeExporter({ stop: "LOGIN" }), chicagoDateTime("2030-06-04", "7:00 am"));
    expect(next.exitCode).toBe(STOP_EXIT);
    expect(await folder()).toEqual([]);
    expect(await logText()).toContain("leftover deleted=1");
    expect(await prisma.shift.findMany({ orderBy: { id: "asc" } })).toEqual(shiftsBefore);
  });

  it("exit 3 DUPLICATE: a clean no-change, workbook deleted", async () => {
    const body = await syntheticXlsx(MORNING);
    await run(fakeExporter({ body }), MORNING_RUN);
    const res = await run(fakeExporter({ body }), AFTERNOON_RUN);
    expect(res).toMatchObject({ exitCode: 3, workbookDeleted: true });
    expect(res.importResult).toMatchObject({ outcome: "refused", code: "DUPLICATE" });
    expect(await folder()).toEqual([]);
  });

  it("exit 3 WRONG_WEEK, EMPTY and UNREADABLE: stops, nothing written, workbook deleted", async () => {
    const cases: Array<[string, Buffer]> = [
      ["WRONG_WEEK", await syntheticXlsx(MORNING.map((row) => ({ ...row, date: "2030-05-27" })))],
      ["EMPTY", await syntheticXlsx([])],
      ["UNREADABLE", Buffer.from("not a workbook")],
    ];
    for (const [code, body] of cases) {
      const res = await run(fakeExporter({ body }), MORNING_RUN);
      expect(res).toMatchObject({ exitCode: 3, workbookDeleted: true });
      expect(res.importResult).toMatchObject({ outcome: "refused", code });
      expect(await folder()).toEqual([]);
    }
    expect(await prisma.shift.count()).toBe(0);
    expect(await prisma.importBatch.count()).toBe(0);
  });

  it("exit 4 no-file: nothing matched, nothing to delete", async () => {
    const noFile: FolderImportResult = {
      outcome: "no-file",
      mode: "hold",
      file: null,
      code: null,
      rowCount: 0,
      dates: [],
      refusals: {},
    };
    const res = await runWiwExport(settings, {
      exporter: fakeExporter({ body: await syntheticXlsx(MORNING) }),
      readLogin,
      now: () => MORNING_RUN,
      runImport: async () => noFile,
    });
    expect(res).toMatchObject({ exitCode: 4, workbookDeleted: true });
    expect(await folder()).toEqual([]);
    expect(await logText()).toContain("import outcome=no-file");
  });

  it("exit 1 import error: the error line is logged first, then the workbook is deleted", async () => {
    const res = await run(fakeExporter({ body: await syntheticXlsx(MORNING) }), MORNING_RUN, {
      runImport: fakeImportThrows,
    });
    expect(res).toMatchObject({ exitCode: 1, workbookDeleted: true });
    expect(await folder()).toEqual([]);
    const log = await logText();
    expect(log.indexOf("import error=IMPORT")).toBeGreaterThan(log.indexOf(`saved file=${TARGET}`));

    // The error line is on disk while the workbook is still there: a run cut off
    // between the two leaves a workbook with its line, never a deletion with no line.
    const seen: Array<[string, boolean]> = [];
    await runWiwExport(settings, {
      exporter: fakeExporter({ body: await syntheticXlsx(MORNING) }),
      readLogin,
      now: () => MORNING_RUN,
      runImport: fakeImportThrows,
      appendLog: async (file, text) => {
        seen.push([text, (await folder()).includes(TARGET)]);
        await appendFile(file, text);
      },
    });
    const errorLine = seen.find(([text]) => text.includes("import error=IMPORT"));
    expect(errorLine?.[1]).toBe(true);
    expect(seen.at(-1)).toEqual([expect.stringContaining("end exit=1 workbook=deleted"), false]);
    expect(log).toContain("end exit=1 workbook=deleted");
    // Codes only: the error's own text is not logged.
    expect(log).not.toContain("database locked");
  });

  it("leaves files that are not this job's alone", async () => {
    await writeFile(path.join(settings.importDir, "Schedule for May 31, 2030 - Jun 6, 2030.xlsx"), "x");
    await writeFile(path.join(settings.importDir, "notes.txt"), "x");
    await run(fakeExporter({ stop: "PAGE" }), MORNING_RUN);
    expect(await folder()).toEqual(["Schedule for May 31, 2030 - Jun 6, 2030.xlsx", "notes.txt"]);
  });
});

describe("B2 stop codes", () => {
  for (const code of ["LOGIN", "MFA", "CAPTCHA", "PAGE"] as const) {
    it(`${code}: one log line, exit ${STOP_EXIT}, no workbook, no import, board unchanged`, async () => {
      await run(fakeExporter({ body: await syntheticXlsx(MORNING) }), MORNING_RUN);
      const shiftsBefore = await prisma.shift.count();
      const batchesBefore = await prisma.importBatch.count();
      const runImport = vi.fn();
      const ex = fakeExporter({ stop: code });
      const res = await runWiwExport(settings, { exporter: ex, readLogin, now: () => AFTERNOON_RUN, runImport });
      expect(res).toMatchObject({ exitCode: STOP_EXIT, stop: code, importResult: null });
      expect(runImport).not.toHaveBeenCalled();
      expect(ex.closed).toBe(1);
      expect(await folder()).toEqual([]);
      expect(await prisma.shift.count()).toBe(shiftsBefore);
      expect(await prisma.importBatch.count()).toBe(batchesBefore);
      const stops = (await logText()).split("\n").filter((l) => l.includes(" stop="));
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatch(new RegExp(`wiw-export stop=${code}$`));
    });
  }

  it("a step that throws without a code is PAGE, and its text is not logged", async () => {
    const res = await run(fakeExporter({ throws: true }), MORNING_RUN);
    expect(res).toMatchObject({ exitCode: STOP_EXIT, stop: "PAGE" });
    const log = await logText();
    expect(log).toContain("stop=PAGE reason=STEP");
    expect(log).not.toContain("locator timed out");
  });

  it("a download under another name is PAGE: discarded, never saved or imported", async () => {
    const ex = fakeExporter({ body: await syntheticXlsx(MORNING), name: "Schedule for May 24, 2030 - May 30, 2030.xlsx" });
    const res = await run(ex, MORNING_RUN);
    expect(res).toMatchObject({ exitCode: STOP_EXIT, stop: "PAGE" });
    expect(ex.discarded).toBe(1);
    expect(await folder()).toEqual([]);
    expect(await prisma.shift.count()).toBe(0);
    expect(await logText()).toContain("stop=PAGE reason=DOWNLOAD_NAME");
  });

  it("a login file that fails its checks is LOGIN with the check's code", async () => {
    await chmod(settings.loginFile, 0o644);
    const res = await run(fakeExporter({ signIn: true, body: await syntheticXlsx(MORNING) }), MORNING_RUN);
    expect(res).toMatchObject({ exitCode: STOP_EXIT, stop: "LOGIN" });
    expect(await logText()).toContain("stop=LOGIN reason=MODE");
    expect(await prisma.shift.count()).toBe(0);
  });

  it("a missing login file is LOGIN MISSING", async () => {
    await rm(settings.loginFile);
    const res = await run(fakeExporter({ signIn: true }), MORNING_RUN);
    expect(res.stop).toBe("LOGIN");
    expect(await logText()).toContain("stop=LOGIN reason=MISSING");
  });
});

describe("B2 login fields never print", () => {
  it("a signed-in run types the fields and no log line or console output carries them", async () => {
    const out: string[] = [];
    const capture = (chunk: unknown) => {
      out.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(capture as typeof process.stderr.write);
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void out.push(args.map(String).join(" ")));
    }

    const ex = fakeExporter({ signIn: true, body: await syntheticXlsx(MORNING) });
    const res = await run(ex, MORNING_RUN);
    expect(res.exitCode).toBe(0);
    expect(ex.typed).toEqual([{ email: SECRET_EMAIL, password: SECRET_PASSWORD }]);

    // Every stop path that reads the login file, too.
    await run(fakeExporter({ signIn: true, stop: "LOGIN" }), MORNING_RUN);
    await run(fakeExporter({ signIn: true, throws: true }), MORNING_RUN);
    await run(fakeExporter({ signIn: true, body: await syntheticXlsx(MORNING) }), MORNING_RUN, {
      runImport: fakeImportThrows,
    });

    const everything = `${await logText()}\n${out.join("\n")}`;
    expect(everything).not.toContain(SECRET_EMAIL);
    expect(everything).not.toContain(SECRET_PASSWORD);
    expect(everything).not.toContain("sentinel");
  });

  it("the login object shows nothing when printed, inspected or serialized", async () => {
    const login = await readLogin();
    for (const shown of [String(login), `${login}`, JSON.stringify({ login }), inspect(login), inspect({ login }, { depth: 5 })]) {
      expect(shown).not.toContain(SECRET_EMAIL);
      expect(shown).not.toContain(SECRET_PASSWORD);
    }
    expect(Object.keys(login)).toEqual([]);
    expect(login.reveal()).toEqual({ email: SECRET_EMAIL, password: SECRET_PASSWORD });
  });

  it("a malformed file's error carries a code, never a line from the file", () => {
    const bodies = [
      `email=${SECRET_EMAIL}\n`,
      `password=${SECRET_PASSWORD}\n`,
      `email=${SECRET_EMAIL}\npassword=${SECRET_PASSWORD}\nuser=${SECRET_EMAIL}\n`,
      `${SECRET_EMAIL}\n${SECRET_PASSWORD}\n`,
      `email=${SECRET_EMAIL}\nemail=${SECRET_EMAIL}\npassword=${SECRET_PASSWORD}\n`,
    ];
    for (const body of bodies) {
      let caught: unknown;
      try {
        parseLoginFile(body);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoginFileError);
      const e = caught as LoginFileError;
      expect(e.code).toBe("FORMAT");
      for (const shown of [e.message, String(e.stack), inspect(e)]) {
        expect(shown).not.toContain(SECRET_EMAIL);
        expect(shown).not.toContain(SECRET_PASSWORD);
      }
    }
  });
});

describe("B2 locked login file checks", () => {
  const check = (file: string | undefined, uid?: number) =>
    readLoginFile(file, { keepOut: [settings.appDir, settings.importDir, settings.profileDir], uid });
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "OK",
      (e: unknown) => (e instanceof LoginFileError ? e.code : "OTHER"),
    );

  it("reads a mode-600 file of two lines, with comments, blank lines and CRLF", async () => {
    const file = await writeLoginFile(`# filled by XICO\r\n\r\nemail= ${SECRET_EMAIL} \r\npassword=${SECRET_PASSWORD}\r\n`);
    expect((await check(file)).reveal()).toEqual({ email: SECRET_EMAIL, password: SECRET_PASSWORD });
    // A password keeps its spaces and any '='.
    await writeLoginFile(`email=${SECRET_EMAIL}\npassword= a=b c \n`);
    expect((await check(file)).reveal().password).toBe(" a=b c ");
    await chmod(file, 0o400);
    expect(await code(check(file))).toBe("OK");
  });

  it("refuses a file that is not locked, not the user's, a link, or in the wrong place", async () => {
    const good = await writeLoginFile(`email=${SECRET_EMAIL}\npassword=${SECRET_PASSWORD}\n`);
    expect(await code(check(undefined))).toBe("NOT_SET");
    expect(await code(check("secrets/wiw-login"))).toBe("NOT_ABSOLUTE");
    expect(await code(check(path.join(root, "nope")))).toBe("MISSING");

    for (const mode of [0o640, 0o604, 0o644, 0o666]) {
      await chmod(good, mode);
      expect(await code(check(good))).toBe("MODE");
    }
    await chmod(good, 0o600);
    expect(await code(check(good, (process.getuid?.() ?? 0) + 1))).toBe("OWNER");

    const link = path.join(root, "secrets", "link");
    await symlink(good, link);
    expect(await code(check(link))).toBe("NOT_REGULAR");
    expect(await code(check(path.join(root, "secrets")))).toBe("NOT_REGULAR");

    for (const dir of [path.join(settings.appDir, "var"), settings.appDir, settings.importDir, settings.profileDir]) {
      await mkdir(dir, { recursive: true });
      const inside = path.join(dir, "wiw-login");
      await writeFile(inside, `email=${SECRET_EMAIL}\npassword=${SECRET_PASSWORD}\n`);
      await chmod(inside, 0o600);
      expect(await code(check(inside))).toBe("INSIDE_APP");
    }
  });
});

describe("B2 settings", () => {
  const env = {
    FLOOR_BOARDS_IMPORT_DIR: "/srv/exports",
    WIW_LOGIN_FILE: "/Users/boards/.wiw-login",
    WIW_BROWSER_PROFILE: "/Users/boards/.wiw-browser",
  };

  it("needs three absolute paths and logs to var/log/wiw-export.log", () => {
    expect(wiwSettingsFromEnv("/opt/app", env)).toEqual({
      appDir: "/opt/app",
      importDir: "/srv/exports",
      loginFile: "/Users/boards/.wiw-login",
      profileDir: "/Users/boards/.wiw-browser",
      logFile: "/opt/app/var/log/wiw-export.log",
    });
    for (const key of Object.keys(env)) {
      expect(() => wiwSettingsFromEnv("/opt/app", { ...env, [key]: "" })).toThrow(`${key}_NOT_SET`);
      expect(() => wiwSettingsFromEnv("/opt/app", { ...env, [key]: "relative" })).toThrow(`${key}_NOT_ABSOLUTE`);
    }
  });

  it("runs hold only: a Confirm is a manager's, never this job's", () => {
    expect(wiwSettingsFromEnv("/opt/app", { ...env, FLOOR_BOARDS_IMPORT_MODE: "hold" }).importDir).toBe("/srv/exports");
    expect(() => wiwSettingsFromEnv("/opt/app", { ...env, FLOOR_BOARDS_IMPORT_MODE: "apply" })).toThrow(
      "FLOOR_BOARDS_IMPORT_MODE_NOT_HOLD",
    );
  });
});

describe("B2 LaunchAgent", () => {
  it("runs at 07:00 and 16:00 in the GUI session, with the three paths and no login value", () => {
    const plist = launchAgentPlist({
      appDir: "/opt/app",
      nodePath: "/usr/local/bin/node",
      importDir: "/srv/exports",
      loginFile: "/Users/boards/.wiw-login",
      profileDir: "/Users/boards/.wiw-browser",
    });
    expect(plist).toContain(`<key>Label</key><string>${WIW_EXPORT_LABEL}</string>`);
    expect(plist).toContain(
      "<key>StartCalendarInterval</key><array><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict><dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>0</integer></dict></array>",
    );
    expect(plist).toContain("<key>RunAtLoad</key><false/>");
    expect(plist).toContain("<key>LimitLoadToSessionType</key><string>Aqua</string>");
    expect(plist).toContain("<string>/opt/app/scripts/wiw-export.ts</string>");
    expect(plist).toContain("<key>WorkingDirectory</key><string>/opt/app</string>");
    expect(plist).toContain("<key>FLOOR_BOARDS_IMPORT_DIR</key><string>/srv/exports</string>");
    expect(plist).toContain("<key>WIW_LOGIN_FILE</key><string>/Users/boards/.wiw-login</string>");
    expect(plist).toContain("<key>WIW_BROWSER_PROFILE</key><string>/Users/boards/.wiw-browser</string>");
    expect(plist).not.toContain("FLOOR_BOARDS_IMPORT_MODE");
    expect(plist).not.toMatch(/password|email/i);
  });

  it("escapes a path for XML", () => {
    const plist = launchAgentPlist({
      appDir: "/opt/a&b",
      nodePath: "/n",
      importDir: "/x<y>",
      loginFile: "/l",
      profileDir: "/p",
    });
    expect(plist).toContain("/opt/a&amp;b/scripts/wiw-export.ts");
    expect(plist).toContain("/x&lt;y&gt;");
  });
});

describe("B2 carve-out and no capture", () => {
  it("the script header carries the carve-out line word for word", async () => {
    const header = (await readFile(path.join(__dirname, "..", "scripts", "wiw-export.ts"), "utf8"))
      .split("*/")[0]!
      .replace(/\n \* ?/g, " ")
      .replace(/\s+/g, " ");
    expect(header).toContain(
      "This job only: a timer on T MAC MINI may export the current Friday-through-Thursday When I Work schedule into the floor boards. The weekly schedule skill, the weekly timesheet skill, and the LOLA360 daily export stay supervised on Rich's Mac, one person-started run at a time.",
    );
  });

  it("the browser step never traces, screenshots or records", async () => {
    const src = await readFile(path.join(__dirname, "..", "src", "lib", "wiw-export", "browser.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const call of ["tracing", "screenshot", "recordVideo", "recordHar", "console.", "process.stdout", "process.stderr"]) {
      expect(code).not.toContain(call);
    }
  });
});
