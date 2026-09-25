/**
 * B2 next week: after this week's export imports or comes back DUPLICATE, the
 * run exports the following Friday through Thursday and imports that file by
 * its own path and week. The run's exit code stays this week's. The browser
 * step for the next week is a fake here (the real one waits on the probe).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFolderImport, type FolderImportResult } from "@/lib/import/folder-import";
import { readLoginFile } from "@/lib/wiw-export/login-file";
import {
  ExportStop,
  runWiwExport,
  STOP_EXIT,
  type DownloadedExport,
  type ImportRunner,
  type ScheduleExporter,
  type StopCode,
  type WiwExportSettings,
} from "@/lib/wiw-export/run";
import { expectedDownloadName, followingWeek, importFileName } from "@/lib/wiw-export/week";
import { chicagoDateTime } from "@/lib/time";
import { dbSnapshot, resetScheduleTables, syntheticXlsx, type SyntheticRow } from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();

/** Monday 3 Jun 2030: this week 31 May..6 Jun, next week 7..13 Jun. */
const D = "2030-06-03";
const N = "2030-06-10";
const RUN = chicagoDateTime(D, "7:00 am");
const WEEK = { friday: "2030-05-31", thursday: "2030-06-06" };
const NEXT = { friday: "2030-06-07", thursday: "2030-06-13" };
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

const THIS = [r("7301", "Abril", "8:00 am", "4:00 pm"), r("7302", "Bruno", "9:00 am", "7:00 pm")];
const NEXT_ROWS = [r("7301", "Abril", "8:00 am", "4:00 pm", N), r("7303", "Carla", "10:00 am", "6:00 pm", "2030-06-13")];

type Plan = { body?: Buffer; name?: string; stop?: StopCode; reason?: string; throws?: boolean };

type Fake = ScheduleExporter & { weeks: string[]; nextWeeks: string[]; closed: number };

function exporter(thisPlan: Plan, nextPlan?: Plan): Fake {
  const download = (plan: Plan, fallback: string): DownloadedExport => ({
    suggestedName: plan.name ?? fallback,
    saveAs: (target) => writeFile(target, plan.body ?? Buffer.from("")),
    discard: async () => undefined,
  });
  const ex: Fake = {
    weeks: [],
    nextWeeks: [],
    closed: 0,
    async exportWeek(week) {
      ex.weeks.push(`${week.friday}..${week.thursday}`);
      if (thisPlan.stop) throw new ExportStop(thisPlan.stop, thisPlan.reason);
      return download(thisPlan, expectedDownloadName(WEEK));
    },
    async close() {
      ex.closed += 1;
    },
  };
  if (nextPlan) {
    ex.exportNextWeek = async (week) => {
      ex.nextWeeks.push(`${week.friday}..${week.thursday}`);
      if (nextPlan.stop) throw new ExportStop(nextPlan.stop, nextPlan.reason);
      if (nextPlan.throws) throw new Error(`locator timed out near ${SECRET_EMAIL}`);
      return download(nextPlan, expectedDownloadName(NEXT));
    };
  }
  return ex;
}

let root: string;
let settings: WiwExportSettings;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "b2-next-week-"));
  const appDir = path.join(root, "app");
  settings = {
    appDir,
    importDir: path.join(root, "exports"),
    profileDir: path.join(root, "browser"),
    loginFile: path.join(root, "secrets", "wiw-login"),
    logFile: path.join(appDir, "var", "log", "wiw-export.log"),
    importMode: "apply",
  };
  await mkdir(settings.importDir, { recursive: true });
  await mkdir(settings.profileDir, { recursive: true });
  await mkdir(path.dirname(settings.loginFile), { recursive: true });
  await writeFile(settings.loginFile, `email=${SECRET_EMAIL}\npassword=${SECRET_PASSWORD}\n`);
  await chmod(settings.loginFile, 0o600);
  await resetScheduleTables(prisma);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const readLogin = () =>
  readLoginFile(settings.loginFile, { keepOut: [settings.appDir, settings.importDir, settings.profileDir] });

const run = (ex: ScheduleExporter, extra: { runImport?: ImportRunner } = {}) =>
  runWiwExport(settings, { exporter: ex, readLogin, now: () => RUN, ...extra });

const log = () => readFile(settings.logFile, "utf8").catch(() => "");
const folder = async () => (await readdir(settings.importDir)).sort();

/** Active shift dates on the board, sorted, one entry per shift. */
async function boardDates(): Promise<string[]> {
  const shifts = await prisma.shift.findMany({ where: { supersededAt: null } });
  return shifts.map((s) => s.date).sort();
}

describe("B2 next week: when it starts", () => {
  it("this week imported: exports the next week, imports it by its own week, exit stays 0, both files gone", async () => {
    const ex = exporter({ body: await syntheticXlsx(THIS) }, { body: await syntheticXlsx(NEXT_ROWS) });
    const res = await run(ex);
    expect(res).toMatchObject({ exitCode: 0, stop: null, workbookDeleted: true });
    expect(res.next).toMatchObject({ status: "imported", reason: null });
    expect(res.next.importResult).toMatchObject({ outcome: "imported", file: importFileName(NEXT), mode: "apply" });
    expect(ex.weeks).toEqual(["2030-05-31..2030-06-06"]);
    expect(ex.nextWeeks).toEqual(["2030-06-07..2030-06-13"]);
    expect(ex.closed).toBe(2);
    expect(await boardDates()).toEqual([D, D, N, "2030-06-13"]);
    expect(await folder()).toEqual([]);

    const text = await log();
    // This week first, next week after, the end line last and still this week's.
    const order = [
      `saved file=${importFileName(WEEK)}`,
      "import outcome=imported mode=apply",
      "next start week=2030-06-07..2030-06-13",
      `next saved file=${importFileName(NEXT)}`,
      `next import outcome=imported mode=apply code=- file=${importFileName(NEXT)} rows=2`,
      "next=imported",
      "end exit=0 workbook=deleted",
    ].map((line) => text.indexOf(line));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const secret of [SECRET_EMAIL, SECRET_PASSWORD, "Abril", "Carla", "7303"]) expect(text).not.toContain(secret);
  });

  it("this week DUPLICATE: the next week still runs, exit stays 3", async () => {
    const body = await syntheticXlsx(THIS);
    await run(exporter({ body }));
    const ex = exporter({ body }, { body: await syntheticXlsx(NEXT_ROWS) });
    const res = await run(ex);
    expect(res.exitCode).toBe(3);
    expect(res.importResult).toMatchObject({ outcome: "refused", code: "DUPLICATE" });
    expect(res.next.status).toBe("imported");
    expect(ex.nextWeeks).toHaveLength(1);
    expect(await boardDates()).toEqual([D, D, N, "2030-06-13"]);
  });

  it("this week EMPTY, WRONG_WEEK or REFUSED: the next export never starts", async () => {
    const overlap = [...THIS, r("7301", "Abril", "2:00 pm", "6:00 pm")];
    const cases: Array<[string, Buffer]> = [
      ["EMPTY", await syntheticXlsx([])],
      ["WRONG_WEEK", await syntheticXlsx(THIS.map((row) => ({ ...row, date: "2030-05-27" })))],
      ["REFUSED", await syntheticXlsx(overlap)],
    ];
    for (const [code, body] of cases) {
      const ex = exporter({ body }, { body: await syntheticXlsx(NEXT_ROWS) });
      const res = await run(ex);
      expect(res.exitCode).toBe(3);
      expect(res.next).toMatchObject({ status: "skipped", reason: `THIS_WEEK_${code}` });
      expect(ex.nextWeeks).toEqual([]);
      expect(await log()).toContain(`next=skipped reason=THIS_WEEK_${code}`);
    }
    expect(await prisma.shift.count()).toBe(0);
  });

  it("this week held (hold mode): the next export never starts, the held workbook stays", async () => {
    await run(exporter({ body: await syntheticXlsx(THIS) }));
    settings = { ...settings, importMode: "hold" };
    const changed = [r("7301", "Abril", "8:00 am", "4:00 pm"), r("7302", "Bruno", "9:00 am", "3:00 pm")];
    const ex = exporter({ body: await syntheticXlsx(changed) }, { body: await syntheticXlsx(NEXT_ROWS) });
    const res = await run(ex);
    expect(res).toMatchObject({ exitCode: 2, workbookDeleted: false });
    expect(res.next).toMatchObject({ status: "skipped", reason: "THIS_WEEK_HELD" });
    expect(ex.nextWeeks).toEqual([]);
    expect(await folder()).toEqual([importFileName(WEEK)]);
  });

  it("this week stopped (exit 5) or import error (exit 1): no next export", async () => {
    const stopped = exporter({ stop: "MFA" }, { body: await syntheticXlsx(NEXT_ROWS) });
    const a = await run(stopped);
    expect(a.exitCode).toBe(STOP_EXIT);
    expect(a.next).toMatchObject({ status: "skipped", reason: "THIS_WEEK_STOP" });
    expect(stopped.nextWeeks).toEqual([]);

    const failing = exporter({ body: await syntheticXlsx(THIS) }, { body: await syntheticXlsx(NEXT_ROWS) });
    const b = await run(failing, {
      runImport: async () => {
        throw new Error(`database locked for ${SECRET_EMAIL}`);
      },
    });
    expect(b.exitCode).toBe(1);
    expect(b.next).toMatchObject({ status: "skipped", reason: "THIS_WEEK_ERROR" });
    expect(failing.nextWeeks).toEqual([]);
    expect(await log()).not.toContain(SECRET_EMAIL);
  });
});

describe("B2 next week: a miss is next=skipped and changes nothing else", () => {
  it("no browser step yet: next=skipped reason=NO_BROWSER_STEP, exit 0", async () => {
    const res = await run(exporter({ body: await syntheticXlsx(THIS) }));
    expect(res.exitCode).toBe(0);
    expect(res.next).toMatchObject({ status: "skipped", reason: "NO_BROWSER_STEP" });
    expect(await log()).toContain("next=skipped reason=NO_BROWSER_STEP");
    expect(await boardDates()).toEqual([D, D]);
  });

  it("a stop on the next week (dialog date, code screen, thrown step): skipped with the code, exit 0, this week kept", async () => {
    const plans: Array<[Plan, string]> = [
      [{ stop: "PAGE", reason: "DIALOG_DATE" }, "PAGE:DIALOG_DATE"],
      [{ stop: "MFA" }, "MFA"],
      [{ throws: true }, "PAGE:STEP"],
    ];
    for (const [plan, reason] of plans) {
      await resetScheduleTables(prisma);
      const res = await run(exporter({ body: await syntheticXlsx(THIS) }, plan));
      expect(res.exitCode).toBe(0);
      expect(res.next).toMatchObject({ status: "skipped", reason });
      expect(await boardDates()).toEqual([D, D]);
      expect(await folder()).toEqual([]);
    }
    expect(await log()).not.toContain(SECRET_EMAIL);
  });

  it("wrong download name: skipped DOWNLOAD_NAME, nothing saved", async () => {
    const res = await run(
      exporter({ body: await syntheticXlsx(THIS) }, { body: await syntheticXlsx(NEXT_ROWS), name: expectedDownloadName(WEEK) }),
    );
    expect(res.next).toMatchObject({ status: "skipped", reason: "DOWNLOAD_NAME" });
    expect(await folder()).toEqual([]);
    expect(await boardDates()).toEqual([D, D]);
  });

  it("unpublished next week (EMPTY) and a next file carrying this week's days (WRONG_WEEK): skipped, this week untouched", async () => {
    const reach = [r("7302", "Bruno", "1:00 pm", "9:00 pm"), ...NEXT_ROWS];
    const cases: Array<[string, Buffer]> = [
      ["EMPTY", await syntheticXlsx([])],
      ["WRONG_WEEK", await syntheticXlsx(reach)],
    ];
    for (const [code, body] of cases) {
      await resetScheduleTables(prisma);
      const res = await run(exporter({ body: await syntheticXlsx(THIS) }, { body }));
      const before = await dbSnapshot(prisma);
      expect(res.exitCode).toBe(0);
      expect(res.next).toMatchObject({ status: "skipped", reason: code });
      expect(await log()).toContain(`next=skipped reason=${code}`);
      expect(await boardDates()).toEqual([D, D]);
      expect(await dbSnapshot(prisma)).toBe(before);
      expect(await folder()).toEqual([]);
    }
  });

  it("next week unchanged since the last run: next=duplicate", async () => {
    const thisBody = await syntheticXlsx(THIS);
    const nextBody = await syntheticXlsx(NEXT_ROWS);
    await run(exporter({ body: thisBody }, { body: nextBody }));
    const res = await run(exporter({ body: thisBody }, { body: nextBody }));
    expect(res.exitCode).toBe(3);
    expect(res.next.status).toBe("duplicate");
    expect(await log()).toContain("next=duplicate");
  });

  it("next week changed in apply mode: the new shift replaces the old one, this week's rows are the same rows", async () => {
    await run(exporter({ body: await syntheticXlsx(THIS) }, { body: await syntheticXlsx(NEXT_ROWS) }));
    const thisWeekRows = async () =>
      JSON.stringify(await prisma.shift.findMany({ where: { date: D }, orderBy: { id: "asc" } }));
    const before = await thisWeekRows();
    const moved = [r("7301", "Abril", "11:00 am", "7:00 pm", N), NEXT_ROWS[1]!];
    const res = await run(exporter({ body: await syntheticXlsx(THIS) }, { body: await syntheticXlsx(moved) }));
    expect(res.next.status).toBe("imported");
    expect(await thisWeekRows()).toBe(before);
    const monday = await prisma.shift.findMany({ where: { date: N, supersededAt: null } });
    expect(monday.map((s) => s.startAt.toISOString())).toEqual([chicagoDateTime(N, "11:00 am").toISOString()]);
  });

  it("next week held in hold mode: skipped NEEDS_CONFIRM, file deleted", async () => {
    await run(exporter({ body: await syntheticXlsx(THIS) }, { body: await syntheticXlsx(NEXT_ROWS) }));
    settings = { ...settings, importMode: "hold" };
    const moved = [r("7301", "Abril", "11:00 am", "7:00 pm", N), NEXT_ROWS[1]!];
    const res = await run(exporter({ body: await syntheticXlsx(THIS) }, { body: await syntheticXlsx(moved) }));
    expect(res.exitCode).toBe(3);
    expect(res.next).toMatchObject({ status: "skipped", reason: "NEEDS_CONFIRM" });
    expect(await folder()).toEqual([]);
  });

  it("the next import throws: skipped IMPORT, the error text never logged, exit stays", async () => {
    let calls = 0;
    const res = await run(exporter({ body: await syntheticXlsx(THIS) }, { body: await syntheticXlsx(NEXT_ROWS) }), {
      runImport: async (dir, at, one) => {
        calls += 1;
        if (calls === 2) throw new Error(`database locked for ${SECRET_EMAIL}`);
        return runFolderImport({ dir, mode: "apply" }, { now: at, file: one?.file, week: one?.week });
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.next).toMatchObject({ status: "skipped", reason: "IMPORT" });
    expect(await folder()).toEqual([]);
    expect(await log()).not.toContain(SECRET_EMAIL);
  });
});

describe("folder import by path and week", () => {
  it("takes the named file, not the newest, and checks it against the named week", async () => {
    const dir = settings.importDir;
    const nextFile = path.join(dir, importFileName(NEXT));
    const newer = path.join(dir, importFileName(WEEK));
    await writeFile(nextFile, await syntheticXlsx(NEXT_ROWS));
    await writeFile(newer, await syntheticXlsx(THIS));
    const later = new Date(Date.now() + 60_000);
    await utimes(newer, later, later);

    const res: FolderImportResult = await runFolderImport(
      { dir, mode: "apply" },
      { now: RUN, file: nextFile, week: followingWeek(WEEK) },
    );
    expect(res).toMatchObject({ outcome: "imported", file: importFileName(NEXT) });
    expect(await boardDates()).toEqual([N, "2030-06-13"]);

    // The same file against this week's dates: every date must fall inside the named week.
    const wrong = await runFolderImport({ dir, mode: "apply" }, { now: RUN, file: nextFile, week: WEEK });
    expect(wrong).toMatchObject({ outcome: "refused", code: "WRONG_WEEK" });
    // A missing named file is no-file, never the newest one instead.
    const missing = await runFolderImport({ dir, mode: "apply" }, { now: RUN, file: path.join(dir, "Schedule_for_x.xlsx") });
    expect(missing).toMatchObject({ outcome: "no-file", file: null });
    // Without a file or week, the folder import is as before: newest file, must bracket today.
    const plain = await runFolderImport({ dir, mode: "apply" }, { now: RUN });
    expect(plain).toMatchObject({ outcome: "imported", file: importFileName(WEEK) });
  });
});
