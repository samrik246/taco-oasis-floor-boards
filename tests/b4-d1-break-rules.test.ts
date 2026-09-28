/**
 * B4 D1: break rules and the passcode store. No screen. Made-up codes only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { PASSCODE_BACKUP_DIR_NAME } from "@/lib/breaks/passcode-import";
import { verifyStaffPasscode } from "@/lib/breaks/passcode";
import {
  assessBreak,
  breakAllowanceMinutes,
  breakBlackouts,
  calendarWeekday,
  saveBreak,
  scheduledMinutes,
} from "@/lib/breaks/rules";
import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";
import { chicagoDateOffset } from "@/lib/date-math";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { MANDATORY_STATIONS, uncoveredMandatory } from "@/lib/mandatory";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const stamp = `b4d1-${Date.now()}`;
const TEST_PEPPER = "b4-d1-test-pepper-0123456789abcdef";
const root = path.resolve(__dirname, "..");
const priorPepper = process.env.STAFF_PASSCODE_PEPPER;

function ymdForWeekday(weekday: number): string {
  let date = "2038-06-01";
  for (let step = 0; step < 7; step += 1) {
    if (calendarWeekday(date) === weekday) return date;
    date = chicagoDateOffset(date, 1);
  }
  throw new Error("no calendar date");
}

const wednesday = ymdForWeekday(3);
const saturday = ymdForWeekday(6);
const sunday = ymdForWeekday(0);
const wednesdayNext = chicagoDateOffset(wednesday, 7);
const wednesdayAfter = chicagoDateOffset(wednesday, 14);
const saturdayNext = chicagoDateOffset(saturday, 7);

async function person(externalId: string, firstName: string) {
  return prisma.employee.create({
    data: { externalId: `${stamp}-${externalId}`, firstName, lastName: "Moss" },
  });
}

async function shiftFor(
  employeeId: string,
  date: string,
  board: string,
  start: string,
  end: string,
) {
  return prisma.shift.create({
    data: {
      employeeId,
      date,
      board,
      sourcePosition: "Cocina",
      startAt: chicagoDateTime(date, start),
      endAt: chicagoDateTime(date, end),
    },
  });
}

function runImport(args: string[], env: NodeJS.ProcessEnv = process.env): {
  status: number;
  output: string;
  counts: {
    rows: number;
    matched: number;
    unmatched: number;
    malformed: number;
    duplicateIds: number;
  };
} {
  const read = (value: string | Buffer | undefined) => value?.toString() ?? "";
  let status = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/import-staff-passcodes.ts", ...args],
      { cwd: root, env, encoding: "utf8" },
    );
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    status = failed.status ?? 1;
    stdout = read(failed.stdout);
    stderr = read(failed.stderr);
  }
  const line = stdout.split("\n").map((row) => row.trim()).find((row) => row.startsWith("{"));
  if (!line) throw new Error(`no count line in ${JSON.stringify(stdout)}`);
  return { status, output: `${stdout}${stderr}`, counts: JSON.parse(line) };
}

describe("B4 D1 break rules", () => {
  afterAll(async () => {
    if (priorPepper === undefined) delete process.env.STAFF_PASSCODE_PEPPER;
    else process.env.STAFF_PASSCODE_PEPPER = priorPepper;
    const people = await prisma.employee.findMany({
      where: { externalId: { startsWith: stamp } },
      select: { id: true },
    });
    const ids = people.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.staffBreak.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.staffPasscode.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.mandatoryMark.deleteMany({ where: { managerId: { in: ids } } });
      await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.boardChangeLog.deleteMany({ where: { managerId: { in: ids } } });
      await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.staffBreakLock.deleteMany();
    await prisma.$disconnect();
  });

  it("K1 allowance bounds and a split shift sum", () => {
    expect(breakAllowanceMinutes(359)).toBe(15);
    expect(breakAllowanceMinutes(360)).toBe(30);
    expect(breakAllowanceMinutes(479)).toBe(30);
    expect(breakAllowanceMinutes(480)).toBe(60);
    expect(breakAllowanceMinutes(600)).toBe(60);
    expect(breakAllowanceMinutes(601)).toBe(90);
    const date = wednesday;
    const minutes = scheduledMinutes([
      {
        id: "a", board: "cocina",
        startAt: chicagoDateTime(date, "8:00 am"),
        endAt: chicagoDateTime(date, "11:00 am"),
      },
      {
        id: "b", board: "cocina",
        startAt: chicagoDateTime(date, "2:00 pm"),
        endAt: chicagoDateTime(date, "5:00 pm"),
        supersededAt: new Date(),
      },
      {
        id: "c", board: "caja",
        startAt: chicagoDateTime(date, "2:00 pm"),
        endAt: chicagoDateTime(date, "5:00 pm"),
      },
    ]);
    expect(minutes).toBe(360);
    expect(breakAllowanceMinutes(minutes)).toBe(30);
  });

  it("K1 an other-board shift does not raise the caja or cocina allowance", async () => {
    const date = wednesday;
    const cocina = {
      id: "cocina", board: "cocina",
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "11:00 am"),
    };
    const other = {
      id: "other", board: "other",
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "5:00 pm"),
    };
    const minutes = scheduledMinutes([cocina, other]);
    expect(minutes).toBe(180);
    expect(breakAllowanceMinutes(minutes)).toBe(15);
    const shifts = [cocina, other];
    expect(assessBreak({
      date,
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "8:30 am"),
      shifts,
      otherBreaks: [],
    })).toEqual({ code: "ALLOWANCE" });
    expect(assessBreak({
      date,
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "8:15 am"),
      shifts,
      otherBreaks: [],
    })).toMatchObject({ board: "cocina", shiftId: "cocina" });

    const nia = await person("nia", "Nia");
    await shiftFor(nia.id, date, "cocina", "8:00 am", "11:00 am");
    await shiftFor(nia.id, date, "other", "8:00 am", "5:00 pm");
    await expect(saveBreak({
      employeeId: nia.id,
      date,
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "8:30 am"),
    })).rejects.toMatchObject({ code: "ALLOWANCE" });
    await saveBreak({
      employeeId: nia.id,
      date,
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "8:15 am"),
    });
  });

  it("K2 blackouts are half-open, weekdays only at lunch, and come from breakBlackouts", () => {
    const source = fs.readFileSync(path.join(root, "src/lib/breaks/rules.ts"), "utf8");
    const assess = source.slice(source.indexOf("export function assessBreak"), source.indexOf("function isBusy"));
    expect(assess).toContain("breakBlackouts(");
    expect(assess).not.toContain("11:00");
    expect(assess).not.toContain("6:00 pm");
    expect(calendarWeekday(wednesday)).toBe(3);
    expect(calendarWeekday(saturday)).toBe(6);
    expect(breakBlackouts(saturday, "cocina")).toHaveLength(1);
    expect(breakBlackouts(wednesday, "caja").map((window) => window.start.toISOString())).toContain(
      chicagoDateTime(wednesday, "11:00 am").toISOString(),
    );

    const day = (date: string) => [{
      id: "s", board: "cocina",
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "7:00 pm"),
    }];
    expect(assessBreak({
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "11:00 am"),
      endAt: chicagoDateTime(wednesday, "11:15 am"),
      shifts: day(wednesday),
      otherBreaks: [],
    })).toEqual({ code: "BLACKOUT" });
    expect(assessBreak({
      date: saturday,
      startAt: chicagoDateTime(saturday, "12:00 pm"),
      endAt: chicagoDateTime(saturday, "12:15 pm"),
      shifts: day(saturday),
      otherBreaks: [],
    })).toMatchObject({ board: "cocina" });
    expect(assessBreak({
      date: sunday,
      startAt: chicagoDateTime(sunday, "12:00 pm"),
      endAt: chicagoDateTime(sunday, "12:15 pm"),
      shifts: day(sunday),
      otherBreaks: [],
    })).toMatchObject({ board: "cocina" });
    expect(assessBreak({
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "5:00 pm"),
      endAt: chicagoDateTime(wednesday, "6:00 pm"),
      shifts: day(wednesday),
      otherBreaks: [],
    })).toMatchObject({ board: "cocina" });
    expect(assessBreak({
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "6:00 pm"),
      endAt: chicagoDateTime(wednesday, "6:15 pm"),
      shifts: day(wednesday),
      otherBreaks: [],
    })).toEqual({ code: "BLACKOUT" });
    expect(assessBreak({
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "9:07 am"),
      endAt: chicagoDateTime(wednesday, "9:22 am"),
      shifts: day(wednesday),
      otherBreaks: [],
    })).toEqual({ code: "ALIGNMENT" });
  });

  it("K3 same-board overlap is refused, back-to-back and the other board are allowed", async () => {
    const ada = await person("ada", "Ada");
    const bea = await person("bea", "Bea");
    const cam = await person("cam", "Cam");
    await shiftFor(ada.id, wednesday, "cocina", "8:00 am", "5:00 pm");
    await shiftFor(bea.id, wednesday, "cocina", "8:00 am", "5:00 pm");
    await shiftFor(cam.id, wednesday, "caja", "8:00 am", "5:00 pm");
    await saveBreak({
      employeeId: ada.id,
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "9:00 am"),
      endAt: chicagoDateTime(wednesday, "9:30 am"),
    });
    await expect(saveBreak({
      employeeId: bea.id,
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "9:15 am"),
      endAt: chicagoDateTime(wednesday, "9:45 am"),
    })).rejects.toMatchObject({ code: "OVERLAP" });
    await saveBreak({
      employeeId: bea.id,
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "9:30 am"),
      endAt: chicagoDateTime(wednesday, "10:00 am"),
    });
    await saveBreak({
      employeeId: cam.id,
      date: wednesday,
      startAt: chicagoDateTime(wednesday, "9:00 am"),
      endAt: chicagoDateTime(wednesday, "9:30 am"),
    });
    const rows = await prisma.staffBreak.findMany({ where: { date: wednesday, employeeId: { in: [ada.id, bea.id, cam.id] } } });
    expect(rows).toHaveLength(3);
    const cocina = rows.filter((row) => row.board === "cocina").sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    expect(cocina[0]!.endAt.getTime()).toBe(cocina[1]!.startAt.getTime());
  });

  it("K3 two concurrent saves leave no overlapping pair", async () => {
    const date = saturday;
    const dee = await person("dee", "Dee");
    const eve = await person("eve", "Eve");
    await shiftFor(dee.id, date, "cocina", "8:00 am", "5:00 pm");
    await shiftFor(eve.id, date, "cocina", "8:00 am", "5:00 pm");
    const attempt = (employeeId: string) => saveBreak({
      employeeId,
      date,
      startAt: chicagoDateTime(date, "10:00 am"),
      endAt: chicagoDateTime(date, "10:30 am"),
    });
    const results = await Promise.allSettled([attempt(dee.id), attempt(eve.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rows = await prisma.staffBreak.findMany({ where: { date, board: "cocina", employeeId: { in: [dee.id, eve.id] } } });
    expect(rows).toHaveLength(1);
  });

  it("K4 a second save replaces the first, and a miss keeps the old row", async () => {
    const fay = await person("fay", "Fay");
    const date = wednesdayNext;
    await shiftFor(fay.id, date, "cocina", "8:00 am", "5:00 pm");
    await shiftFor(fay.id, date, "other", "8:00 am", "5:00 pm");
    const first = await saveBreak({
      employeeId: fay.id,
      date,
      startAt: chicagoDateTime(date, "9:00 am"),
      endAt: chicagoDateTime(date, "9:15 am"),
    });
    expect(first.replaced).toBe(false);
    await expect(saveBreak({
      employeeId: fay.id,
      date,
      startAt: chicagoDateTime(date, "7:00 am"),
      endAt: chicagoDateTime(date, "7:15 am"),
    })).rejects.toMatchObject({ code: "OUTSIDE_SHIFT" });
    const kept = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: fay.id, date } },
    });
    expect(kept.id).toBe(first.id);
    expect(kept.startAt.toISOString()).toBe(chicagoDateTime(date, "9:00 am").toISOString());
    const second = await saveBreak({
      employeeId: fay.id,
      date,
      startAt: chicagoDateTime(date, "2:00 pm"),
      endAt: chicagoDateTime(date, "3:00 pm"),
    });
    expect(second.replaced).toBe(true);
    expect(second.id).toBe(first.id);
    const rows = await prisma.staffBreak.findMany({ where: { employeeId: fay.id, date } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endAt.toISOString()).toBe(chicagoDateTime(date, "3:00 pm").toISOString());
    const log = await prisma.boardChangeLog.findFirstOrThrow({
      where: { managerId: fay.id, route: BOARD_CHANGE_ROUTES.breakSave, summary: `${date} start=14:00 end=15:00` },
    });
    expect(log.managerName).toBe("Fay Moss");
    expect(log.summary).not.toContain("Fay");
    expect(rows[0]!.actor).toBe(fay.id);
    const moves = await prisma.positionMoveLog.count();
    await saveBreak({
      employeeId: fay.id,
      date,
      startAt: chicagoDateTime(date, "3:00 pm"),
      endAt: chicagoDateTime(date, "3:15 pm"),
    });
    expect(await prisma.positionMoveLog.count()).toBe(moves);
    const onlyOther = await person("gus", "Gus");
    await shiftFor(onlyOther.id, date, "other", "8:00 am", "5:00 pm");
    await expect(saveBreak({
      employeeId: onlyOther.id,
      date,
      startAt: chicagoDateTime(date, "9:00 am"),
      endAt: chicagoDateTime(date, "9:15 am"),
    })).rejects.toMatchObject({ code: "OTHER_BOARD" });
  });

  it("K4 a split day refuses a block longer than the summed allowance", async () => {
    const hal = await person("hal", "Hal");
    const date = saturdayNext;
    await shiftFor(hal.id, date, "cocina", "8:00 am", "11:00 am");
    await shiftFor(hal.id, date, "cocina", "2:00 pm", "5:00 pm");
    await expect(saveBreak({
      employeeId: hal.id,
      date,
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "8:45 am"),
    })).rejects.toMatchObject({ code: "ALLOWANCE" });
    await saveBreak({
      employeeId: hal.id,
      date,
      startAt: chicagoDateTime(date, "8:00 am"),
      endAt: chicagoDateTime(date, "8:30 am"),
    });
  });

  it("K5 a saved break does not change assignments, marks, or gaps", async () => {
    const ida = await person("ida", "Ida");
    const date = wednesdayAfter;
    const worked = await shiftFor(ida.id, date, "cocina", "8:00 am", "5:00 pm");
    await prisma.assignment.create({
      data: {
        shiftId: worked.id,
        employeeId: ida.id,
        stationId: "pdf_tq1r",
        hourStart: chicagoHourStart(date, 12),
        hourEnd: chicagoHourEnd(date, 12),
      },
    });
    await prisma.mandatoryMark.deleteMany({ where: { board: "cocina", date, stationId: "pdf_crne" } });
    await prisma.mandatoryMark.create({
      data: { board: "cocina", date, stationId: "pdf_crne", managerId: ida.id },
    });
    const hours = Array.from({ length: HOUR_GRID_END - HOUR_GRID_START }, (_, index) => HOUR_GRID_START + index);
    const gaps = async () => {
      const shifts = await prisma.shift.findMany({
        where: { date, board: "cocina", supersededAt: null },
        include: { assignments: true },
      });
      return uncoveredMandatory({
        stationIds: MANDATORY_STATIONS,
        hours,
        date,
        shifts: shifts.map((shift) => ({
          id: shift.id,
          date: shift.date,
          startAt: shift.startAt.toISOString(),
          endAt: shift.endAt.toISOString(),
          supersededAt: shift.supersededAt?.toISOString() ?? null,
          assignments: shift.assignments.map((assignment) => ({
            stationId: assignment.stationId,
            hourStart: assignment.hourStart.toISOString(),
          })),
        })),
      });
    };
    const beforeGaps = await gaps();
    const beforeAssignments = await prisma.assignment.findMany({ orderBy: { id: "asc" } });
    const beforeMarks = await prisma.mandatoryMark.findMany({ orderBy: { id: "asc" } });
    await saveBreak({
      employeeId: ida.id,
      date,
      startAt: chicagoDateTime(date, "9:00 am"),
      endAt: chicagoDateTime(date, "10:00 am"),
    });
    expect(await gaps()).toEqual(beforeGaps);
    expect(await prisma.assignment.findMany({ orderBy: { id: "asc" } })).toEqual(beforeAssignments);
    expect(await prisma.mandatoryMark.findMany({ orderBy: { id: "asc" } })).toEqual(beforeMarks);
  });

  it("K6 dry run prints counts only, and apply backs up before an idempotent write", async () => {
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
    const known = await person("known", "Quilla");
    const csv = path.join(os.tmpdir(), `${stamp}-made-up.csv`);
    fs.writeFileSync(csv, [
      `${known.externalId},Quilla,Moss,1111`,
      "ext-missing-person,Quilla,Moss,2222",
    ].join("\n"));
    const dry = runImport([
      "--file", csv, "--id-column", "1", "--code-column", "4",
    ]);
    expect(dry.status).toBe(0);
    expect(dry.output).not.toContain(known.externalId);
    expect(dry.output).not.toContain("Quilla");
    expect(dry.output).not.toContain("1111");
    expect(dry.output).not.toContain("2222");
    expect(dry.counts).toEqual({
      rows: 2, matched: 1, unmatched: 1, malformed: 0, duplicateIds: 0,
    });
    expect(await prisma.staffPasscode.count({ where: { employeeId: known.id } })).toBe(0);

    const bad = path.join(os.tmpdir(), `${stamp}-bad.csv`);
    fs.writeFileSync(bad, `${known.externalId},12\n`);
    const refused = runImport(["--file", bad, "--id-column", "1", "--code-column", "2", "--apply"]);
    expect(refused.status).toBe(1);
    expect(refused.counts.malformed).toBe(1);
    expect(await prisma.staffPasscode.count({ where: { employeeId: known.id } })).toBe(0);

    const dbUrl = process.env.DATABASE_URL ?? "";
    const dbFile = dbUrl.slice("file:".length);
    const backupDir = path.join(path.dirname(dbFile), PASSCODE_BACKUP_DIR_NAME);
    const beforeBackups = new Set(fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []);
    const applied = runImport([
      "--file", csv, "--id-column", "1", "--code-column", "4", "--apply",
    ]);
    expect(applied.status).toBe(0);
    expect(applied.output).not.toContain("1111");
    const created = fs.readdirSync(backupDir).filter((name) => !beforeBackups.has(name) && name.endsWith(".db"));
    expect(created).toHaveLength(1);
    const backed = execFileSync("sqlite3", [
      path.join(backupDir, created[0]!),
      'SELECT COUNT(*) FROM "StaffPasscode"',
    ], { encoding: "utf8" });
    expect(backed.trim()).toBe("0");
    expect(await verifyStaffPasscode(known.id, "1111")).toBe(true);
    expect(await verifyStaffPasscode(known.id, "9999")).toBe(false);
    expect(await prisma.employee.findUnique({ where: { externalId: "ext-missing-person" } })).toBeNull();
    const salt = (await prisma.staffPasscode.findUniqueOrThrow({ where: { employeeId: known.id } })).salt;
    const again = runImport(["--file", csv, "--id-column", "1", "--code-column", "4", "--apply"]);
    expect(again.status).toBe(0);
    expect(await prisma.staffPasscode.count({ where: { employeeId: known.id } })).toBe(1);
    expect(await verifyStaffPasscode(known.id, "1111")).toBe(true);
    expect((await prisma.staffPasscode.findUniqueOrThrow({ where: { employeeId: known.id } })).salt).not.toBe(salt);

    const dup = path.join(os.tmpdir(), `${stamp}-dup.csv`);
    fs.writeFileSync(dup, `${known.externalId},1111\n${known.externalId},3333\n`);
    const dupRun = runImport(["--file", dup, "--id-column", "1", "--code-column", "2", "--apply"]);
    expect(dupRun.status).toBe(1);
    expect(dupRun.counts.duplicateIds).toBe(1);
    expect(await verifyStaffPasscode(known.id, "1111")).toBe(true);

    const bareEnv = { ...process.env };
    delete bareEnv.STAFF_PASSCODE_PEPPER;
    const noPepper = runImport(["--file", csv, "--id-column", "1", "--code-column", "4"], bareEnv);
    expect(noPepper.status).toBe(1);
    expect(noPepper.output).not.toContain("Quilla");
    await expect(verifyStaffPasscode(known.id, "1111")).resolves.toBe(true);
    delete process.env.STAFF_PASSCODE_PEPPER;
    await expect(verifyStaffPasscode(known.id, "1111")).rejects.toMatchObject({ code: "PEPPER" });
    process.env.STAFF_PASSCODE_PEPPER = TEST_PEPPER;
    expect(await verifyStaffPasscode(`${stamp}-nobody`, "1111")).toBe(false);
    fs.rmSync(csv, { force: true });
    fs.rmSync(bad, { force: true });
    fs.rmSync(dup, { force: true });
  });

  it("K7 no API returns a passcode, and db push is additive", async () => {
    const home = fs.readFileSync(path.join(root, "scripts/home-base.sh"), "utf8");
    expect(home).toContain('INITIAL_MANAGER_CODE=""');
    expect(home).not.toContain("STAFF_PASSCODE_PEPPER");
    const readTree = (dir: string): string => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return readTree(full);
      return /\.(ts|tsx)$/.test(entry.name) ? fs.readFileSync(full, "utf8") : "";
    }).join("\n");
    const app = readTree(path.join(root, "src/app"));
    expect(app).not.toContain("StaffPasscode");
    expect(app).not.toContain("verifyStaffPasscode");

    const current = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
    const start = current.indexOf("/// One salted scrypt passcode");
    expect(start).toBeGreaterThan(0);
    const old = current.slice(0, start).trimEnd() + "\n";
    expect(old).not.toContain("model StaffPasscode");
    expect(old).not.toContain("model StaffBreak");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b4-d1-push-"));
    const dbUrl = `file:${path.join(tmp, "home-base.db")}`;
    const env = { ...process.env, DATABASE_URL: dbUrl };
    const run = (args: string[]) => execFileSync("pnpm", args, { cwd: root, env, encoding: "utf8" });
    fs.writeFileSync(path.join(tmp, "schema.prisma"), old);
    const created = Date.parse("2035-04-01T00:00:00Z");
    try {
      run(["exec", "prisma", "db", "push", "--schema", path.join(tmp, "schema.prisma"), "--skip-generate"]);
      const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
      await db.$executeRawUnsafe(
        `INSERT INTO "Employee" (id, externalId, firstName, lastName, email, createdAt, updatedAt) VALUES ('b4e','b4e','Ada','Moss',NULL,${created},${created})`,
      );
      await db.$disconnect();
      const push = run(["exec", "prisma", "db", "push", "--skip-generate"]);
      expect(push).not.toMatch(/accept-data-loss|data loss/i);
      expect(push).toMatch(/in sync|already in sync|Your database is now in sync/i);
      const after = new PrismaClient({ datasources: { db: { url: dbUrl } } });
      const employees = await after.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Employee"`);
      expect(employees).toEqual([{ id: "b4e" }]);
      const tables = await after.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('StaffPasscode','StaffBreak','StaffBreakLock') ORDER BY name`,
      );
      expect(tables.map((table) => table.name)).toEqual(["StaffBreak", "StaffBreakLock", "StaffPasscode"]);
      await after.$disconnect();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
