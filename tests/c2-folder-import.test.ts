import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAssignment } from "@/lib/assignments/service";
import {
  EXIT_CODES,
  formatSummary,
  newestExport,
  runFolderImport,
  settingsFromEnv,
  type FolderImportMode,
} from "@/lib/import/folder-import";
import { chicagoDateTime } from "@/lib/time";
import {
  dbSnapshot,
  resetScheduleTables,
  syntheticCsv,
  syntheticXlsx,
  type SyntheticRow,
} from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();
const D = "2030-06-03";
const D2 = "2030-06-04";
/** 7:00 in Chicago on D: nothing has started yet. */
const MORNING_RUN = chicagoDateTime(D, "7:00 am");
/** 16:00 in Chicago on D: hours 7–15 have started. */
const AFTERNOON_RUN = chicagoDateTime(D, "4:00 pm");

const r = (
  employeeId: string,
  firstName: string,
  start: string,
  end: string,
  opts: Partial<SyntheticRow> = {},
): SyntheticRow => ({
  position: "Caja - Regular",
  firstName,
  lastName: "Ejemplo",
  employeeId,
  date: D,
  start,
  end,
  ...opts,
});

const MORNING: SyntheticRow[] = [
  r("6301", "Abril", "8:00 am", "4:00 pm", { email: "abril@example.invalid" }),
  r("6302", "Bruno", "9:00 am", "7:00 pm"),
  r("6303", "Celia", "5:00 pm", "9:00 pm"),
  r("6304", "Dario", "8:00 am", "2:00 pm", { position: "Cocina" }),
  r("6301", "Abril", "9:00 am", "5:00 pm", { date: D2 }),
];

// Afternoon: Bruno leaves at 3; Celia's evening shift is gone; Dario unchanged.
const AFTERNOON: SyntheticRow[] = [
  r("6301", "Abril", "8:00 am", "4:00 pm"),
  r("6302", "Bruno", "9:00 am", "3:00 pm"),
  r("6304", "Dario", "8:00 am", "2:00 pm", { position: "Cocina" }),
  r("6301", "Abril", "9:00 am", "5:00 pm", { date: D2 }),
];

let dir: string;
let clock = 1_900_000_000;

/** Drop an export into the folder, newer than anything already there. */
async function drop(name: string, body: Buffer) {
  const file = path.join(dir, name);
  await writeFile(file, body);
  clock += 60;
  await utimes(file, clock, clock);
  return file;
}

const run = (now: Date, mode: FolderImportMode = "hold") =>
  runFolderImport({ dir, mode }, { now });

async function liveShifts(externalId: string, date = D) {
  return prisma.shift.findMany({
    where: { employee: { externalId }, date, supersededAt: null },
    orderBy: { startAt: "asc" },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "c2-folder-import-"));
  await resetScheduleTables(prisma);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("C2 import from folder", () => {
  it("imports a first file for the day in one step", async () => {
    await drop("Schedule_for_morning.csv", syntheticCsv(MORNING));
    const res = await run(MORNING_RUN);
    expect(res.outcome).toBe("imported");
    expect(res.rowCount).toBe(5);
    expect(await prisma.shift.count()).toBe(5);
    expect(await prisma.importBatch.count()).toBe(1);
    expect(EXIT_CODES[res.outcome]).toBe(0);
  });

  it("refuses the same file twice by fingerprint and changes nothing", async () => {
    await drop("Schedule_for_morning.csv", syntheticCsv(MORNING));
    expect((await run(MORNING_RUN)).outcome).toBe("imported");
    const before = await dbSnapshot(prisma);

    const again = await run(MORNING_RUN);
    expect(again).toMatchObject({ outcome: "refused", code: "DUPLICATE" });
    expect(await dbSnapshot(prisma)).toBe(before);

    // Same rows under a new name (a second download) is still the same schedule.
    await drop("Schedule_for_morning_copy.xlsx", await syntheticXlsx(MORNING));
    expect(await run(AFTERNOON_RUN)).toMatchObject({ outcome: "refused", code: "DUPLICATE" });
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("hold (default): a changed afternoon file writes nothing and waits for a manager's Confirm", async () => {
    await drop("Schedule_for_morning.csv", syntheticCsv(MORNING));
    await run(MORNING_RUN);
    const before = await dbSnapshot(prisma);

    await drop("Schedule_for_afternoon.csv", syntheticCsv(AFTERNOON));
    const res = await run(AFTERNOON_RUN);
    expect(res).toMatchObject({ outcome: "held", code: "NEEDS_CONFIRM", mode: "hold" });
    expect(EXIT_CODES[res.outcome]).toBe(2);
    const day = res.dates.find((d) => d.date === D)!;
    expect(day).toMatchObject({ unchanged: 2, changed: 1, removed: 1, added: 0 });
    expect(await dbSnapshot(prisma)).toBe(before);

    // Held again on the next run: nothing was recorded, nothing changed.
    expect((await run(AFTERNOON_RUN)).outcome).toBe("held");
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("apply: a changed afternoon file goes through preview and Confirm and keeps identities", async () => {
    await drop("Schedule_for_morning.csv", syntheticCsv(MORNING));
    await run(MORNING_RUN, "apply");
    const brunoBefore = await prisma.employee.findUniqueOrThrow({ where: { externalId: "6302" } });
    const employeesBefore = await prisma.employee.count();

    // A started hour (9) and a future hour (17) past Bruno's new end.
    const sh = (await liveShifts("6302"))[0]!;
    const at9 = await createAssignment({
      shiftId: sh.id,
      stationId: "green2",
      date: D,
      hour: 9,
      now: chicagoDateTime(D, "8:30 am"),
    });
    const at17 = await createAssignment({
      shiftId: sh.id,
      stationId: "green2",
      date: D,
      hour: 17,
      now: chicagoDateTime(D, "8:30 am"),
    });
    expect(at9.ok && at17.ok).toBe(true);

    await drop("Schedule_for_afternoon.csv", syntheticCsv(AFTERNOON));
    const res = await run(AFTERNOON_RUN, "apply");
    expect(res).toMatchObject({ outcome: "imported", mode: "apply" });
    const day = res.dates.find((d) => d.date === D)!;
    expect(day.assignmentsToRemove).toBe(1);

    const bruno = await liveShifts("6302");
    expect(bruno).toHaveLength(1);
    expect(bruno[0]!.endAt.toISOString()).toBe(chicagoDateTime(D, "3:00 pm").toISOString());
    expect(bruno[0]!.employeeId).toBe(brunoBefore.id);
    expect(await liveShifts("6303")).toHaveLength(0);
    expect(await prisma.employee.count()).toBe(employeesBefore);
    const kept = await prisma.assignment.findMany({ where: { shift: { employeeId: brunoBefore.id } } });
    expect(kept.map((a) => a.hourStart.toISOString())).toEqual([
      chicagoDateTime(D, "9:00 am").toISOString(),
    ]);
    // Email from the export is never stored.
    const abril = await prisma.employee.findUniqueOrThrow({ where: { externalId: "6301" } });
    expect(abril.email ?? null).toBeNull();
    expect(await prisma.importBatch.count()).toBe(2);
  });

  it("imports a partial-hour shift with exact minutes", async () => {
    await drop(
      "Schedule_for_partial.csv",
      syntheticCsv([r("6311", "Elena", "10:30 am", "2:45 pm")]),
    );
    expect((await run(MORNING_RUN)).outcome).toBe("imported");
    const [s] = await liveShifts("6311");
    expect(s!.startAt.toISOString()).toBe(chicagoDateTime(D, "10:30 am").toISOString());
    expect(s!.endAt.toISOString()).toBe(chicagoDateTime(D, "2:45 pm").toISOString());
  });

  it("imports a double shift as two shifts for one employee", async () => {
    await drop(
      "Schedule_for_double.xlsx",
      await syntheticXlsx([
        r("6312", "Geli", "8:00 am", "12:00 pm"),
        r("6312", "Geli", "4:00 pm", "9:00 pm"),
      ]),
    );
    expect((await run(MORNING_RUN)).outcome).toBe("imported");
    const shifts = await liveShifts("6312");
    expect(shifts).toHaveLength(2);
    expect(new Set(shifts.map((s) => s.employeeId)).size).toBe(1);
    expect(await prisma.employee.count({ where: { externalId: "6312" } })).toBe(1);
  });

  it("refuses a file for the wrong week and writes nothing", async () => {
    const lastWeek = MORNING.map((row) => ({ ...row, date: "2030-05-27" }));
    await drop("Schedule_for_last_week.csv", syntheticCsv(lastWeek));
    const before = await dbSnapshot(prisma);
    const res = await run(MORNING_RUN, "apply");
    expect(res).toMatchObject({ outcome: "refused", code: "WRONG_WEEK" });
    expect(EXIT_CODES[res.outcome]).toBe(3);
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("refuses a file with no shift rows (header only, or open shifts only)", async () => {
    await drop("Schedule_for_empty.csv", syntheticCsv([]));
    expect(await run(MORNING_RUN)).toMatchObject({ outcome: "refused", code: "EMPTY" });

    await drop(
      "Schedule_for_open_only.csv",
      syntheticCsv([r("", "", "8:00 am", "4:00 pm")]),
    );
    expect(await run(MORNING_RUN)).toMatchObject({ outcome: "refused", code: "EMPTY" });
    expect(await prisma.shift.count()).toBe(0);
    expect(await prisma.importBatch.count()).toBe(0);
  });

  it("reports an empty folder, and ignores files that are not exports", async () => {
    const res = await run(MORNING_RUN);
    expect(res).toMatchObject({ outcome: "no-file", file: null });
    expect(EXIT_CODES[res.outcome]).toBe(4);

    await drop("notes.csv", syntheticCsv(MORNING));
    await drop(".Schedule_for_hidden.csv", syntheticCsv(MORNING));
    expect((await run(MORNING_RUN)).outcome).toBe("no-file");
    expect(await prisma.shift.count()).toBe(0);
  });

  it("refuses an unreadable export by code only", async () => {
    await drop("Schedule_for_broken.csv", Buffer.from("not,a,schedule\n1,2,3\n"));
    expect(await run(MORNING_RUN)).toMatchObject({ outcome: "refused", code: "UNREADABLE" });
  });

  it("picks the newest export by modified time", async () => {
    await drop("Schedule_for_b.csv", syntheticCsv(MORNING));
    const newer = await drop("Schedule_for_a.csv", syntheticCsv(AFTERNOON));
    expect(await newestExport(dir)).toBe(newer);
  });

  it("prints counts and codes, never a name, Employee ID or email", async () => {
    await drop("Schedule_for_morning.csv", syntheticCsv(MORNING));
    const imported = formatSummary(await run(MORNING_RUN)).join("\n");
    await drop("Schedule_for_afternoon.csv", syntheticCsv(AFTERNOON));
    const held = formatSummary(await run(AFTERNOON_RUN)).join("\n");
    for (const text of [imported, held]) {
      for (const token of ["Abril", "Bruno", "Celia", "Dario", "Ejemplo", "6301", "6302", "example.invalid"]) {
        expect(text).not.toContain(token);
      }
    }
    expect(held).toContain("outcome=held");
  });
});

describe("C2 folder import settings", () => {
  it("defaults to hold and needs an absolute folder", () => {
    expect(settingsFromEnv({ FLOOR_BOARDS_IMPORT_DIR: "/tmp/x" })).toEqual({ dir: "/tmp/x", mode: "hold" });
    expect(
      settingsFromEnv({ FLOOR_BOARDS_IMPORT_DIR: "/tmp/x", FLOOR_BOARDS_IMPORT_MODE: "APPLY" }).mode,
    ).toBe("apply");
    expect(() => settingsFromEnv({})).toThrow(/FLOOR_BOARDS_IMPORT_DIR/);
    expect(() => settingsFromEnv({ FLOOR_BOARDS_IMPORT_DIR: "exports" })).toThrow(/absolute/);
    expect(() =>
      settingsFromEnv({ FLOOR_BOARDS_IMPORT_DIR: "/tmp/x", FLOOR_BOARDS_IMPORT_MODE: "auto" }),
    ).toThrow(/hold/);
  });
});
