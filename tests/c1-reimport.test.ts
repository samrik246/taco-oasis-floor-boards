import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import {
  commitImport,
  ImportRefusedError,
  previewImport,
} from "@/lib/import/persist-import";
import { createAssignment } from "@/lib/assignments/service";
import { getEmployeeWeekHours } from "@/lib/ledger";
import { isHourInShift } from "@/lib/rules/shift-window";
import { chicagoDateTime } from "@/lib/time";
import { GET as getDay } from "@/app/api/boards/[board]/days/[date]/route";
import {
  dbSnapshot,
  resetScheduleTables,
  syntheticCsv,
  type SyntheticRow,
} from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();
const D = "2030-06-03";
const D2 = "2030-06-04";
/** 12:30 in Chicago: hours 7–12 have started. */
const NOW = chicagoDateTime(D, "12:30 pm");

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
  r("5201", "Abril", "8:00 am", "4:00 pm"),
  r("5202", "Bruno", "8:00 am", "6:00 pm"),
  r("5203", "Celia", "9:00 am", "5:00 pm"),
  r("5204", "Dario", "7:00 am", "3:00 pm"),
  r("5206", "Fabian", "8:00 am", "4:00 pm", { position: "Cocina" }),
  r("5201", "Abril", "9:00 am", "5:00 pm", { date: D2 }),
];

// Afternoon: 5201 unchanged + a back-to-back second shift; 5202 now 10:30–2:30;
// 5203 removed; 5204 moved to 1–8 pm; 5206 unchanged + back-to-back; D2 not in file.
const AFTERNOON: SyntheticRow[] = [
  r("5201", "Abril", "8:00 am", "4:00 pm"),
  r("5201", "Abril", "4:00 pm", "8:00 pm"),
  r("5202", "Bruno", "10:30 am", "2:30 pm"),
  r("5204", "Dario", "1:00 pm", "8:00 pm"),
  r("5206", "Fabian", "8:00 am", "4:00 pm", { position: "Cocina" }),
  r("5206", "Fabian", "4:00 pm", "6:00 pm", { position: "Cocina" }),
];

async function parse(rows: SyntheticRow[], name = "file.csv") {
  return parseScheduleWorkbook(syntheticCsv(rows), { filename: name });
}

async function shiftOf(externalId: string, date = D, where: object = {}) {
  return prisma.shift.findFirstOrThrow({
    where: { employee: { externalId }, date, ...where },
    orderBy: { startAt: "asc" },
  });
}

async function assign(externalId: string, stationId: string, hour: number, date = D) {
  const sh = await shiftOf(externalId, date, { supersededAt: null });
  const res = await createAssignment({ shiftId: sh.id, stationId, date, hour, now: NOW });
  if (!res.ok) throw new Error(`assign ${externalId}@${hour}: ${JSON.stringify(res.violations)}`);
  return res.assignment.id;
}

type Seeded = Record<string, string>;

/** Morning import + assignments. Returns assignment ids by label. */
async function seedMorning(): Promise<Seeded> {
  await resetScheduleTables(prisma);
  await commitImport(await parse(MORNING, "morning.csv"), "morning.csv", { now: NOW });
  return {
    abril9: await assign("5201", "green1", 9),
    abril14: await assign("5201", "green1", 14),
    bruno10: await assign("5202", "green2", 10),
    bruno12: await assign("5202", "green2", 12),
    bruno14: await assign("5202", "green2", 14),
    bruno15: await assign("5202", "green2", 15),
    celia11: await assign("5203", "purple1", 11),
    celia14: await assign("5203", "purple1", 14),
    dario9: await assign("5204", "blue", 9),
    dario14: await assign("5204", "blue", 14),
    fabian9: await assign("5206", "fryer", 9),
    abrilD2: await assign("5201", "green1", 10, D2),
  };
}

async function previewAndCommit(rows: SyntheticRow[], name = "afternoon.csv") {
  const parsed = await parse(rows, name);
  const preview = await previewImport(parsed, { now: NOW });
  const result = await commitImport(parsed, name, {
    now: NOW,
    expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
  });
  return { preview, result };
}

async function assignmentIds(): Promise<Set<string>> {
  return new Set((await prisma.assignment.findMany({ select: { id: true } })).map((a) => a.id));
}

/** A9: invariants that must hold after any commit. */
async function expectInvariants() {
  const all = await prisma.assignment.findMany({ include: { shift: true, station: true } });
  for (const a of all) {
    expect(a.station.board, a.id).toBe(a.shift.board);
    expect(a.employeeId, a.id).toBe(a.shift.employeeId);
    if (a.hourStart.getTime() > NOW.getTime()) {
      expect(a.shift.supersededAt, `future ${a.id} on superseded shift`).toBeNull();
      expect(isHourInShift(a.hourStart, a.shift.startAt, a.shift.endAt, a.hourEnd), a.id).toBe(true);
    }
  }
  const keys = (k: (a: (typeof all)[number]) => string) => new Set(all.map(k)).size;
  expect(keys((a) => `${a.stationId}|${a.hourStart.toISOString()}`)).toBe(all.length);
  expect(keys((a) => `${a.employeeId}|${a.hourStart.toISOString()}`)).toBe(all.length);
  // Active shifts of one person never overlap.
  const active = await prisma.shift.findMany({ where: { supersededAt: null } });
  for (const x of active) {
    for (const y of active) {
      if (x.id >= y.id || x.employeeId !== y.employeeId) continue;
      expect(x.startAt < y.endAt && y.startAt < x.endAt, `${x.id}/${y.id} overlap`).toBe(false);
    }
  }
}

describe("C1 same-day re-import (reconcile)", () => {
  let ids: Seeded;

  beforeAll(async () => {
    await resetScheduleTables(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    ids = await seedMorning();
  });

  it("A3: the same file twice is refused and nothing changes", async () => {
    const before = await dbSnapshot(prisma);
    const parsed = await parse(MORNING, "renamed.csv");
    await expect(previewImport(parsed, { now: NOW })).rejects.toThrow("already imported");
    await expect(commitImport(parsed, "renamed.csv", { now: NOW })).rejects.toThrow("Nothing changed");
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("A14: preview writes nothing and reports counts per date", async () => {
    const before = await dbSnapshot(prisma);
    const preview = await previewImport(await parse(AFTERNOON), { now: NOW });
    expect(await dbSnapshot(prisma)).toBe(before);
    expect(preview.needsConfirm).toBe(true);
    expect(preview.refusals).toEqual([]);
    expect(preview.dates).toHaveLength(1);
    expect(preview.dates[0]).toMatchObject({
      date: D,
      added: 2,
      changed: 2,
      replaced: 1,
      unchanged: 2,
      removed: 1,
      skippedOpenShifts: 0,
    });
    // Station + hour only, no names or ids.
    expect(preview.dates[0]!.assignmentsToRemove).toEqual([
      { board: "caja", stationId: "blue", hour: 14 },
      { board: "caja", stationId: "purple1", hour: 14 },
      { board: "caja", stationId: "green2", hour: 15 },
    ].sort((a, b) => a.hour - b.hour || a.stationId.localeCompare(b.stationId)));
    expect(preview.dates[0]!.assignmentsKept).toBe(8);
    expect(JSON.stringify(preview.dates)).not.toMatch(/Abril|Bruno|Celia|Dario|Fabian|520\d/);
  });

  it("A4 A5 A6 A7 A9 A11: the afternoon commit keeps, clips, supersedes and adds correctly", async () => {
    const d2Before = JSON.stringify(
      await prisma.shift.findMany({ where: { date: D2 }, include: { assignments: true }, orderBy: { id: "asc" } }),
    );
    const abrilBefore = await shiftOf("5201");
    const brunoBefore = await shiftOf("5202");
    const darioBefore = await shiftOf("5204");
    const celiaBefore = await shiftOf("5203");
    const employeesBefore = await prisma.employee.count();

    await previewAndCommit(AFTERNOON);
    const left = await assignmentIds();

    // A4: unchanged shift keeps its id and its assignments.
    expect((await shiftOf("5201")).id).toBe(abrilBefore.id);
    expect(left.has(ids.abril9!) && left.has(ids.abril14!)).toBe(true);

    // A5: shortened, every started assigned hour still overlaps -> same id, clipped ledger.
    const bruno = await prisma.shift.findUniqueOrThrow({ where: { id: brunoBefore.id } });
    expect(bruno.supersededAt).toBeNull();
    expect(bruno.startAt.toISOString()).toBe(chicagoDateTime(D, "10:30 am").toISOString());
    expect(left.has(ids.bruno10!)).toBe(true); // started, clipped to 30
    expect(left.has(ids.bruno12!)).toBe(true); // started
    expect(left.has(ids.bruno14!)).toBe(true); // future, 14:00–14:30 still inside
    expect(left.has(ids.bruno15!)).toBe(false); // future, outside -> removed
    expect((await getEmployeeWeekHours(bruno.employeeId, D))!.totalMinutes).toBe(30 + 60 + 30);

    // A6 (removed): superseded, started hour kept as history, future removed.
    const celia = await prisma.shift.findUniqueOrThrow({ where: { id: celiaBefore.id } });
    expect(celia.supersededAt).not.toBeNull();
    expect(left.has(ids.celia11!)).toBe(true);
    expect(left.has(ids.celia14!)).toBe(false);
    expect((await getEmployeeWeekHours(celia.employeeId, D))!.totalMinutes).toBe(60);

    // A6 (moved so a started assigned hour misses): old superseded + new shift added;
    // every future assignment on the old shift removed, even hour 14 the new one covers.
    const darioOld = await prisma.shift.findUniqueOrThrow({ where: { id: darioBefore.id } });
    expect(darioOld.supersededAt).not.toBeNull();
    const darioNew = await shiftOf("5204", D, { supersededAt: null });
    expect(darioNew.id).not.toBe(darioOld.id);
    expect(darioNew.startAt.toISOString()).toBe(chicagoDateTime(D, "1:00 pm").toISOString());
    expect(left.has(ids.dario9!)).toBe(true);
    expect(left.has(ids.dario14!)).toBe(false);
    expect((await getEmployeeWeekHours(darioOld.employeeId, D))!.totalMinutes).toBe(60);
    // A future hour on the superseded shift is refused; the new shift takes it.
    const refused = await createAssignment({ shiftId: darioOld.id, stationId: "blue", date: D, hour: 14, now: NOW });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.violations.map((v) => v.code)).toContain("SHIFT_SUPERSEDED");
    const retaken = await createAssignment({ shiftId: darioNew.id, stationId: "blue", date: D, hour: 14, now: NOW });
    expect(retaken.ok).toBe(true);

    // A7: a new shift for a known ID -> new shift, no new Employee row.
    expect(await prisma.employee.count()).toBe(employeesBefore);
    const abrilShifts = await prisma.shift.findMany({
      where: { employeeId: abrilBefore.employeeId, date: D, supersededAt: null },
    });
    expect(abrilShifts).toHaveLength(2);

    // A11: dates not in the file are unchanged.
    expect(
      JSON.stringify(
        await prisma.shift.findMany({ where: { date: D2 }, include: { assignments: true }, orderBy: { id: "asc" } }),
      ),
    ).toBe(d2Before);

    await expectInvariants();
  });

  it("A6: a superseded shift shows on the day board for its history hours only", async () => {
    const darioBefore = await shiftOf("5204");
    const celiaBefore = await shiftOf("5203");
    await previewAndCommit(AFTERNOON);
    const res = await getDay(new Request(`http://local/api/boards/caja/days/${D}`), {
      params: Promise.resolve({ board: "caja", date: D }),
    });
    const day = (await res.json()) as {
      shifts: Array<{ id: string; supersededAt: string | null; assignments: Array<{ id: string }> }>;
    };
    const old = day.shifts.find((s) => s.id === darioBefore.id)!;
    expect(old.supersededAt).not.toBeNull();
    expect(old.assignments.map((a) => a.id)).toEqual([ids.dario9]);
    expect(day.shifts.find((s) => s.id === celiaBefore.id)?.assignments.map((a) => a.id)).toEqual([ids.celia11]);
  });

  it("A12: a file missing a whole board for a date that has it is refused; nothing changes", async () => {
    const before = await dbSnapshot(prisma);
    const noCocina = AFTERNOON.filter((row) => row.position !== "Cocina");
    const parsed = await parse(noCocina);
    const preview = await previewImport(parsed, { now: NOW });
    expect(preview.refusals).toEqual([
      expect.objectContaining({ code: "BOARD_WIPE", board: "cocina", date: D }),
    ]);
    await expect(
      commitImport(parsed, "x.csv", {
        now: NOW,
        expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
      }),
    ).rejects.toThrow(/cocina.*2030-06-03/);
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("refuses two overlapping shifts of one person; back-to-back is legal", async () => {
    const before = await dbSnapshot(prisma);
    const overlapping = [...AFTERNOON, r("5202", "Bruno", "2:00 pm", "5:00 pm", { position: "Caja - Nieves" })];
    const preview = await previewImport(await parse(overlapping), { now: NOW });
    expect(preview.refusals.map((x) => x.code)).toEqual(["PERSON_OVERLAP"]);
    await expect(commitImport(await parse(overlapping), "o.csv", { now: NOW, expected: preview })).rejects.toThrow(
      /overlap/,
    );
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("A14: commit with another file's fingerprint refuses; nothing changes", async () => {
    const before = await dbSnapshot(prisma);
    const preview = await previewImport(await parse(AFTERNOON), { now: NOW });
    const other = await parse([...AFTERNOON.slice(0, -1)]);
    await expect(
      commitImport(other, "other.csv", {
        now: NOW,
        expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
      }),
    ).rejects.toMatchObject({ code: "FINGERPRINT_MISMATCH" });
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("A14: an assignment made after the preview that changes the removal set -> commit refuses", async () => {
    const parsed = await parse(AFTERNOON);
    const preview = await previewImport(parsed, { now: NOW });
    // A tablet seats the to-be-removed person in a future hour.
    await assign("5203", "purple1", 15);
    const before = await dbSnapshot(prisma);
    const err = await commitImport(parsed, "afternoon.csv", {
      now: NOW,
      expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportRefusedError);
    expect((err as ImportRefusedError).code).toBe("BOARD_CHANGED");
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("an assignment after the preview that does not change the removal set -> commit proceeds", async () => {
    const parsed = await parse(AFTERNOON);
    const preview = await previewImport(parsed, { now: NOW });
    const kept = await assign("5201", "green1", 13);
    await commitImport(parsed, "afternoon.csv", {
      now: NOW,
      expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
    });
    expect((await assignmentIds()).has(kept)).toBe(true);
    await expectInvariants();
  });

  it("a file touching an imported date cannot commit without its preview", async () => {
    const before = await dbSnapshot(prisma);
    await expect(commitImport(await parse(AFTERNOON), "a.csv", { now: NOW })).rejects.toMatchObject({
      code: "PREVIEW_REQUIRED",
    });
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("a unique employee takeover inherits future stations and preserves worked history and unrelated rows", async () => {
    await resetScheduleTables(prisma);
    const morning = [
      r("5301", "Outgoing", "8:00 am", "6:00 pm"),
      r("5309", "Unrelated", "8:00 am", "4:00 pm", { position: "Cocina" }),
      r("5310", "Tomorrow", "9:00 am", "5:00 pm", { date: D2 }),
    ];
    await commitImport(await parse(morning, "takeover-before.csv"), "takeover-before.csv", { now: NOW });
    const outgoing = await shiftOf("5301");
    const tomorrow = await shiftOf("5310", D2);
    const worked = await assign("5301", "purple1", 11);
    const future = await assign("5301", "purple1", 14);
    const unrelated = await assign("5309", "fryer", 10);
    const parsed = await parse([
      r("5302", "Incoming", "8:00 am", "6:00 pm"),
      morning[1]!,
    ], "takeover-after.csv");
    const preview = await previewImport(parsed, { now: NOW });
    expect(preview.dates[0]!.assignmentsToTransfer).toEqual([
      { board: "caja", stationId: "purple1", hour: 14 },
    ]);
    expect(preview.dates[0]!.assignmentsToRemove).toEqual([]);
    await commitImport(parsed, "takeover-after.csv", {
      now: NOW, expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
    });

    const oldRow = await prisma.shift.findUniqueOrThrow({ where: { id: outgoing.id }, include: { assignments: true } });
    const incoming = await shiftOf("5302");
    const incomingCells = await prisma.assignment.findMany({ where: { shiftId: incoming.id } });
    expect(oldRow.supersededAt).not.toBeNull();
    expect(oldRow.assignments.map((a) => a.id)).toEqual([worked]);
    expect(incomingCells).toMatchObject([{ stationId: "purple1", hourStart: chicagoDateTime(D, "2:00 pm") }]);
    expect(incomingCells[0]!.id).not.toBe(future);
    expect((await getEmployeeWeekHours(outgoing.employeeId, D))!.totalMinutes).toBe(60);
    expect((await getEmployeeWeekHours(incoming.employeeId, D))!.totalMinutes).toBe(60);
    expect(await prisma.assignment.findUnique({ where: { id: unrelated } })).not.toBeNull();
    expect((await shiftOf("5310", D2)).id).toBe(tomorrow.id);
    await expectInvariants();
  });

  it("refuses a takeover when the incoming person's station ability forbids an inherited cell", async () => {
    await resetScheduleTables(prisma);
    await commitImport(await parse([r("5321", "Outgoing", "8:00 am", "6:00 pm")], "before.csv"),
      "before.csv", { now: NOW });
    await assign("5321", "purple1", 14);
    const incoming = await prisma.employee.create({
      data: { externalId: "5322", firstName: "Incoming", lastName: "Ejemplo" },
    });
    await prisma.employeeStationAbility.create({
      data: { employeeId: incoming.id, stationId: "purple1", level: "forbidden" },
    });
    const parsed = await parse([r("5322", "Incoming", "8:00 am", "6:00 pm")], "after.csv");
    const preview = await previewImport(parsed, { now: NOW });
    const before = await dbSnapshot(prisma);
    await expect(commitImport(parsed, "after.csv", {
      now: NOW, expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
    })).rejects.toMatchObject({ code: "REFUSED", refusals: [{ code: "TAKEOVER_CONFLICT" }] });
    expect(await dbSnapshot(prisma)).toBe(before);
  });
});

describe("C1 step 6: open shifts in an afternoon file", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("are skipped, counted in the preview, and do not block the commit", async () => {
    await seedMorning();
    const withOpen = [
      ...AFTERNOON,
      r("", "", "11:00 am", "3:00 pm"),
      r("", "", "5:00 pm", "9:00 pm", { position: "Cocina" }),
    ];
    const { preview } = await previewAndCommit(withOpen);
    expect(preview.dates[0]!.skippedOpenShifts).toBe(2);
    expect(preview.refusals).toEqual([]);
    expect(await prisma.employee.count({ where: { externalId: "" } })).toBe(0);
    await expectInvariants();
  });

  it("the board-wipe refusal counts rows after the open-shift skip", async () => {
    await seedMorning();
    const before = await dbSnapshot(prisma);
    const onlyOpenCocina = [
      ...AFTERNOON.filter((row) => row.position !== "Cocina"),
      r("", "", "8:00 am", "4:00 pm", { position: "Cocina" }),
    ];
    const preview = await previewImport(await parse(onlyOpenCocina), { now: NOW });
    expect(preview.refusals.map((x) => x.code)).toEqual(["BOARD_WIPE"]);
    expect(await dbSnapshot(prisma)).toBe(before);
  });
});

describe("an hour that starts between preview and Confirm (fresh review)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("refuses with an accurate message and changes nothing", async () => {
    await seedMorning();
    const parsed = await parse(AFTERNOON);
    const preview = await previewImport(parsed, { now: chicagoDateTime(D, "1:58 pm") });
    const before = await dbSnapshot(prisma);
    const err = await commitImport(parsed, "afternoon.csv", {
      now: chicagoDateTime(D, "2:01 pm"),
      expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
    }).catch((e: unknown) => e);
    expect((err as ImportRefusedError).code).toBe("BOARD_CHANGED");
    expect((err as Error).message).toMatch(/new hour started/);
    expect(await dbSnapshot(prisma)).toBe(before);
  });
});
