/**
 * B3 S4: Pintar row order, tap-time seat refusal, and paint-order numbers.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET as dayBoard } from "@/app/api/boards/[board]/days/[date]/route";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { paintAssignments, type PaintEdit } from "@/lib/assignments/paint";
import { planPaintSeatNumbers } from "@/lib/assignments/seat-number";
import {
  copyDayAssignments,
  createAssignment,
  createShiftAssignment,
  swapAssignments,
} from "@/lib/assignments/service";
import { placeFixedAssignments } from "@/lib/assignments/fixed-assign";
import { suggestAssign } from "@/lib/assignments/suggest";
import { commitImport, previewImport } from "@/lib/import/persist-import";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { removeShift, restoreShift } from "@/lib/shifts/remove-restore";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { chicagoDateTime } from "@/lib/time";
import {
  comparePintarRows,
  compareScheduleRows,
  stationAtSelectedHour,
} from "@/lib/schedule/build-schedule";
import { syntheticCsv, type SyntheticRow } from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();
const root = process.cwd();
const date = "2035-04-16";
const later = "2035-04-17";
const importDate = "2035-04-18";
const stamp = "s4pint";
const actor = { id: `${stamp}-actor`, name: "S4 Actor", route: BOARD_CHANGE_ROUTES.paint };
const early = chicagoDateTime(date, "6:00 am");

const people = {
  ada: { id: `${stamp}-ada`, shift: `${stamp}-ada-shift`, later: `${stamp}-ada-later` },
  nia: { id: `${stamp}-nia`, shift: `${stamp}-nia-shift` },
  cam: { id: `${stamp}-cam`, shift: `${stamp}-cam-shift` },
  rio: { id: `${stamp}-rio`, shift: `${stamp}-rio-shift` },
} as const;

function editOf(
  person: { id: string; shift: string },
  hour: number,
  stationId: string | null,
  expected: PaintEdit["expected"] = null,
  sourcePosition = "Cocina",
): PaintEdit {
  return {
    shiftId: person.shift,
    hour,
    expectedShift: {
      startAt: chicagoDateTime(date, "9:00 am").toISOString(),
      endAt: chicagoDateTime(date, "5:00 pm").toISOString(),
      employeeId: person.id,
      sourcePosition,
    },
    expected,
    stationId,
  };
}

async function seat(person: { id: string; shift: string }, stationId: string, hour: number, seatNumber: number | null) {
  return prisma.assignment.create({
    data: {
      shiftId: person.shift,
      employeeId: person.id,
      stationId,
      hourStart: chicagoHourStart(date, hour),
      hourEnd: chicagoHourEnd(date, hour),
      seatNumber,
    },
  });
}

describe("B3 S4 pintar order", () => {
  const order = new Map([["fryer", 0], ["carne", 2], ["tortilla", 5]]);

  it("D1 Entrada is clock-in then name, Nombre is name, and Puesto uses the selected hour", () => {
    const nia = { name: "Nia Moss", employeeId: "n", startAt: chicagoDateTime(date, "9:00 am").toISOString(), shiftId: "sn", stationId: null as string | null };
    const ada = { name: "Ada Moss", employeeId: "a", startAt: chicagoDateTime(date, "11:00 am").toISOString(), shiftId: "sa", stationId: "tortilla" };
    expect(compareScheduleRows(nia, ada, "time")).toBeLessThan(0);
    expect(comparePintarRows(ada, nia, "name", order)).toBeLessThan(0);
    expect(comparePintarRows(
      { ...ada, stationId: null },
      { ...nia, stationId: "fryer" },
      "position",
      order,
    )).toBeGreaterThan(0);

    const assignments = [8, 9, 10, 11].map((hour) => ({
      stationId: "fryer",
      hourStart: chicagoHourStart(date, hour).toISOString(),
    })).concat([{ stationId: "tortilla", hourStart: chicagoHourStart(date, 12).toISOString() }]);
    expect(stationAtSelectedHour(assignments, date, 12, null)).toBe("tortilla");
    const selected = { ...ada, stationId: stationAtSelectedHour(assignments, date, 12, null) };
    const bea = { name: "Bea Moss", employeeId: "b", startAt: ada.startAt, shiftId: "sb", stationId: "carne" };
    expect(comparePintarRows(bea, selected, "position", order)).toBeLessThan(0);
  });
});

describe("B3 S4 paint numbers", () => {
  afterAll(async () => {
    const ids = Object.values(people).map((person) => person.id);
    const shifts = Object.values(people).flatMap((person) => [person.shift, "later" in person ? person.later : ""]);
    await prisma.boardChangeLog.deleteMany({ where: { managerId: { in: [actor.id, `${stamp}-mgr`] } } });
    await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.shiftRemovalEvent.deleteMany({ where: { override: { externalId: { startsWith: stamp } } } });
    await prisma.shiftRemoval.deleteMany({ where: { externalId: { startsWith: stamp } } });
    await prisma.shift.deleteMany({ where: { id: { in: shifts.filter(Boolean) } } });
    await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    await prisma.positionStationMap.deleteMany({ where: { position: `${stamp}-fijo` } });
    await prisma.manager.deleteMany({ where: { name: `${stamp} Manager` } });
    await prisma.importBatch.deleteMany({ where: { filename: { startsWith: `${stamp}-` } } });
    await prisma.$disconnect();
  });

  it("prepares synthetic cocina people", async () => {
    for (const id of ["pdf_tq1r", "pdf_tq2r", "pdf_tq3r"]) {
      await prisma.station.upsert({
        where: { id },
        create: { id, board: "cocina", label: id, color: "pink", maxConcurrent: 1, sortOrder: 3 },
        update: { board: "cocina", maxConcurrent: 1 },
      });
    }
    await prisma.employee.createMany({
      data: Object.values(people).map((person, index) => ({
        id: person.id,
        externalId: person.id,
        firstName: ["Ada", "Nia", "Cam", "Rio"][index]!,
        lastName: "Moss",
      })),
    });
    const startAt = chicagoDateTime(date, "9:00 am");
    const endAt = chicagoDateTime(date, "5:00 pm");
    await prisma.shift.createMany({
      data: [
        { id: people.ada.shift, employeeId: people.ada.id, board: "cocina", date, sourcePosition: "Cocina", startAt, endAt },
        { id: people.nia.shift, employeeId: people.nia.id, board: "cocina", date, sourcePosition: "Cocina", startAt, endAt },
        { id: people.cam.shift, employeeId: people.cam.id, board: "cocina", date, sourcePosition: "Cocina", startAt, endAt },
        { id: people.rio.shift, employeeId: people.rio.id, board: "cocina", date, sourcePosition: `${stamp}-fijo`, startAt: chicagoDateTime(date, "11:00 am"), endAt: chicagoDateTime(date, "1:00 pm") },
        { id: people.ada.later, employeeId: people.ada.id, board: "cocina", date: later, sourcePosition: "Cocina", startAt: chicagoDateTime(later, "9:00 am"), endAt: chicagoDateTime(later, "5:00 pm") },
      ],
    });
  });

  it("D2 an exact seat already taken is 422 and writes nothing", async () => {
    const held = await seat(people.ada, "pdf_tq1r", 12, null);
    const logs = await prisma.boardChangeLog.count({ where: { managerId: actor.id } });
    const result = await paintAssignments({
      board: "cocina",
      date,
      edits: [editOf(people.nia, 12, "pdf_tq1r")],
    }, early, actor);
    expect(result).toMatchObject({ ok: false, status: 422, code: "STATION_FULL" });
    expect(await prisma.assignment.findMany({ where: { employeeId: people.nia.id } })).toEqual([]);
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: held.id } })).stationId).toBe("pdf_tq1r");
    expect(await prisma.boardChangeLog.count({ where: { managerId: actor.id } })).toBe(logs);
    await prisma.assignment.delete({ where: { id: held.id } });
  });

  it("D3 numbers follow paint order, survive an erase, and stay through a repaint", async () => {
    const first = await paintAssignments({
      board: "cocina",
      date,
      edits: [editOf(people.ada, 12, "pdf_tq2r")],
    }, early, actor);
    expect(first).toEqual({ ok: true, saved: 1 });
    const ada = await prisma.assignment.findFirstOrThrow({ where: { employeeId: people.ada.id, stationId: "pdf_tq2r" } });
    expect(ada.seatNumber).toBe(1);

    const second = await paintAssignments({
      board: "cocina",
      date,
      edits: [editOf(people.nia, 12, "pdf_tq1r")],
    }, early, actor);
    expect(second).toEqual({ ok: true, saved: 1 });
    const nia = await prisma.assignment.findFirstOrThrow({ where: { employeeId: people.nia.id } });
    expect(nia.seatNumber).toBe(2);

    const erased = await paintAssignments({
      board: "cocina",
      date,
      edits: [editOf(people.ada, 12, null, { id: ada.id, stationId: "pdf_tq2r" })],
    }, early, actor);
    expect(erased).toEqual({ ok: true, saved: 1 });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: nia.id } })).seatNumber).toBe(2);

    const third = await paintAssignments({
      board: "cocina",
      date,
      edits: [editOf(people.cam, 12, "pdf_tq3r")],
    }, early, actor);
    expect(third).toEqual({ ok: true, saved: 1 });
    expect((await prisma.assignment.findFirstOrThrow({ where: { employeeId: people.cam.id } })).seatNumber).toBe(1);

    const kept = await paintAssignments({
      board: "cocina",
      date,
      edits: [editOf(people.nia, 12, "pdf_tq2r", { id: nia.id, stationId: "pdf_tq1r" })],
    }, early, actor);
    expect(kept).toEqual({ ok: true, saved: 1 });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: nia.id } })).seatNumber).toBe(2);
    await prisma.assignment.deleteMany({ where: { employeeId: { in: [people.nia.id, people.cam.id, people.ada.id] } } });
  });

  it("reserves a retained number when the newcomer is first in the save", async () => {
    const ada = await seat(people.ada, "pdf_tq2r", 12, 1);
    const planned = planPaintSeatNumbers([
      { key: "cam", employeeId: people.cam.id, hourStartMs: chicagoHourStart(date, 12).getTime(), stationId: "pdf_tq3r", previous: null },
      { key: "ada", employeeId: people.ada.id, hourStartMs: chicagoHourStart(date, 12).getTime(), stationId: "pdf_tq1r", previous: { id: ada.id, stationId: "pdf_tq2r", seatNumber: 1 } },
    ], []);
    expect(planned.numbers.get("ada")).toBe(1);
    expect(planned.numbers.get("cam")).toBe(2);

    const result = await paintAssignments({
      board: "cocina",
      date,
      edits: [
        editOf(people.cam, 12, "pdf_tq3r"),
        editOf(people.ada, 12, "pdf_tq1r", { id: ada.id, stationId: "pdf_tq2r" }),
      ],
    }, early, actor);
    expect(result).toEqual({ ok: true, saved: 2 });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: ada.id } })).seatNumber).toBe(1);
    expect((await prisma.assignment.findFirstOrThrow({ where: { employeeId: people.cam.id } })).seatNumber).toBe(2);
    await prisma.assignment.deleteMany({ where: { employeeId: { in: [people.ada.id, people.cam.id] } } });
  });

  it("D5 a legacy null reads back filled and stays null until a write", async () => {
    const row = await seat(people.ada, "pdf_tq2r", 13, null);
    const manager = await prisma.manager.create({
      data: { name: `${stamp} Manager`, codeHash: hashManagerCode(`${stamp}-code`), role: "manager" },
    });
    const token = signManagerSession({ id: manager.id, name: manager.name });
    const response = await dayBoard(
      new Request(`http://local/api/boards/cocina/days/${date}`, { headers: { "x-manager-session": token } }),
      { params: Promise.resolve({ board: "cocina", date }) },
    );
    const body = await response.json() as { shifts: { assignments: { id: string; seatNumber: number | null }[] }[] };
    const shown = body.shifts.flatMap((shift) => shift.assignments).find((item) => item.id === row.id);
    expect(shown?.seatNumber).toBe(1);
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: row.id } })).seatNumber).toBeNull();
    await prisma.assignment.delete({ where: { id: row.id } });
  });

  it("D4 each write site stores a number, and a null swap keeps distinct read-back numbers", async () => {
    const single = await createAssignment({
      shiftId: people.ada.shift, stationId: "pdf_tq2r", date, hour: 14, now: early,
    });
    expect(single.ok && single.assignment.seatNumber).toBe(1);

    const shift = await createShiftAssignment({
      shiftId: people.nia.shift, stationId: "pdf_tq1r", date, now: early,
    });
    expect(shift.ok).toBe(true);
    const niaRows = await prisma.assignment.findMany({ where: { employeeId: people.nia.id, stationId: "pdf_tq1r" } });
    expect(niaRows.length).toBeGreaterThan(0);
    expect(niaRows.every((row) => (row.seatNumber ?? 0) >= 1)).toBe(true);
    expect(niaRows.find((row) => row.hourStart.getTime() === chicagoHourStart(date, 11).getTime())?.seatNumber).toBe(1);

    await prisma.positionStationMap.create({ data: { position: `${stamp}-fijo`, stationId: "pdf_tq3r" } });
    const fixed = await placeFixedAssignments({ board: "cocina", date, now: early });
    expect(fixed.summary.placed).toBeGreaterThan(0);
    const rioRows = await prisma.assignment.findMany({ where: { employeeId: people.rio.id } });
    expect(rioRows.length).toBeGreaterThan(0);
    expect(rioRows.every((row) => (row.seatNumber ?? 0) >= 1)).toBe(true);

    await prisma.employeeStationAbility.create({
      data: { employeeId: people.cam.id, stationId: "pdf_tq2r", level: "preferred" },
    });
    const suggested = await suggestAssign({
      board: "cocina", date, hour: 15, stationId: "pdf_tq2r", shiftId: people.cam.shift,
    });
    expect(suggested.ok).toBe(true);
    expect((await prisma.assignment.findFirstOrThrow({
      where: { employeeId: people.cam.id, hourStart: chicagoHourStart(date, 15) },
    })).seatNumber).toBeGreaterThanOrEqual(1);

    const copied = await copyDayAssignments({ board: "cocina", sourceDate: date, targetDate: later, now: early });
    expect(copied.ok && copied.summary.copied).toBeGreaterThan(0);
    const copyRows = await prisma.assignment.findMany({ where: { shiftId: people.ada.later } });
    expect(copyRows.length).toBeGreaterThan(0);
    expect(copyRows.every((row) => (row.seatNumber ?? 0) >= 1)).toBe(true);

    await prisma.assignment.deleteMany({
      where: {
        hourStart: chicagoHourStart(date, 16),
        stationId: { in: ["pdf_tq1r", "pdf_tq2r", "pdf_tq3r"] },
      },
    });
    const left = await seat(people.ada, "pdf_tq1r", 16, null);
    const right = await seat(people.nia, "pdf_tq2r", 16, null);
    const swapped = await swapAssignments(left.id, right.id, early);
    expect(swapped.ok).toBe(true);
    const afterLeft = await prisma.assignment.findUniqueOrThrow({ where: { id: left.id } });
    const afterRight = await prisma.assignment.findUniqueOrThrow({ where: { id: right.id } });
    expect(new Set([afterLeft.seatNumber, afterRight.seatNumber])).toEqual(new Set([1, 2]));
    expect(afterLeft.employeeId).toBe(people.nia.id);
    expect(afterLeft.seatNumber).toBe(2);
    expect(afterRight.employeeId).toBe(people.ada.id);
    expect(afterRight.seatNumber).toBe(1);

    const removed = await removeShift({
      shiftId: people.cam.shift,
      board: "cocina",
      date,
      expected: {
        startAt: chicagoDateTime(date, "9:00 am").toISOString(),
        endAt: chicagoDateTime(date, "5:00 pm").toISOString(),
        employeeId: people.cam.id,
        sourcePosition: "Cocina",
      },
      expectedRevision: 0,
      reason: "S4 restore check",
      manager: { id: `${stamp}-mgr`, name: "S4 Manager" },
      now: early,
    });
    const restored = await restoreShift({
      id: removed.id,
      expectedRevision: removed.revision,
      expected: {
        startAt: chicagoDateTime(date, "9:00 am").toISOString(),
        endAt: chicagoDateTime(date, "5:00 pm").toISOString(),
        employeeId: people.cam.id,
        sourcePosition: "Cocina",
      },
      positions: "replay",
      reason: "S4 restore check",
      manager: { id: `${stamp}-mgr`, name: "S4 Manager" },
      now: early,
    });
    expect(restored.restoredCells).toBeGreaterThan(0);
    const replayed = await prisma.assignment.findMany({ where: { employeeId: people.cam.id, stationId: "pdf_tq2r" } });
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((row) => (row.seatNumber ?? 0) >= 1)).toBe(true);
  });

  it("D4 import takeover stores a number on the inherited seat", async () => {
    const row = (employeeId: string, firstName: string): SyntheticRow => ({
      position: "Cocina",
      firstName,
      lastName: "Moss",
      employeeId,
      date: importDate,
      start: "9:00 am",
      end: "5:00 pm",
    });
    const before = await parseScheduleWorkbook(syntheticCsv([row(`${stamp}-out`, "Out")]), { filename: `${stamp}-before.csv` });
    await commitImport(before, `${stamp}-before.csv`, { now: chicagoDateTime(importDate, "6:00 am") });
    const outgoing = await prisma.shift.findFirstOrThrow({
      where: { employee: { externalId: `${stamp}-out` }, date: importDate },
    });
    await prisma.assignment.create({
      data: {
        shiftId: outgoing.id,
        employeeId: outgoing.employeeId,
        stationId: "pdf_tq2r",
        hourStart: chicagoHourStart(importDate, 14),
        hourEnd: chicagoHourEnd(importDate, 14),
        seatNumber: null,
      },
    });
    const parsed = await parseScheduleWorkbook(syntheticCsv([row(`${stamp}-in`, "In")]), { filename: `${stamp}-after.csv` });
    const preview = await previewImport(parsed, { now: chicagoDateTime(importDate, "6:00 am") });
    await commitImport(parsed, `${stamp}-after.csv`, {
      now: chicagoDateTime(importDate, "6:00 am"),
      expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest },
    });
    const incoming = await prisma.shift.findFirstOrThrow({
      where: { employee: { externalId: `${stamp}-in` }, date: importDate, supersededAt: null },
      include: { assignments: true },
    });
    expect(incoming.assignments.map((item) => item.seatNumber)).toEqual([1]);
    await prisma.assignment.deleteMany({ where: { shift: { date: importDate, employee: { externalId: { in: [`${stamp}-out`, `${stamp}-in`] } } } } });
    await prisma.shift.deleteMany({ where: { employee: { externalId: { in: [`${stamp}-out`, `${stamp}-in`] } } } });
    await prisma.employee.deleteMany({ where: { externalId: { in: [`${stamp}-out`, `${stamp}-in`] } } });
  });
});

describe("B3 S4 schema upgrade", () => {
  it("D6 db push from d0ab53e adds seatNumber without a data-loss prompt", async () => {
    const oldSchema = fs.readFileSync(path.join(root, "tests", "fixtures", "schema-d0ab53e.prisma"), "utf8");
    expect(createHash("sha256").update(oldSchema).digest("hex")).toBe(
      "d237a887fa4263e17c9716eb355fa2b2a275f73e0d3eaa6dc9cb6c8638c90acf",
    );
    expect(oldSchema).not.toContain("seatNumber");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b3-s4-push-"));
    const dbUrl = `file:${path.join(tmp, "home-base.db")}`;
    const env = { ...process.env, DATABASE_URL: dbUrl };
    const run = (args: string[]) => execFileSync("pnpm", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });
    fs.writeFileSync(path.join(tmp, "schema.prisma"), oldSchema);
    fs.writeFileSync(path.join(tmp, "home-base.db"), "");
    try {
      run(["exec", "prisma", "db", "push", "--schema", path.join(tmp, "schema.prisma"), "--skip-generate"]);
      const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
      await db.$executeRawUnsafe(`INSERT INTO "Station" (id, board, label, color, maxConcurrent, sortOrder, priority, shortCode) VALUES ('pdf_tq1r','cocina','Taquero 1','pink',1,3,NULL,'')`);
      await db.$executeRawUnsafe(`INSERT INTO "Employee" (id, externalId, firstName, lastName, email, createdAt, updatedAt) VALUES ('s4e','s4e','Ada','Moss',NULL,${Date.parse("2035-04-01T00:00:00Z")},${Date.parse("2035-04-01T00:00:00Z")})`);
      await db.$executeRawUnsafe(`INSERT INTO "ImportBatch" (id, filename, fingerprint, importedAt, rowCount) VALUES ('s4b','s4.csv','${"b".repeat(64)}',${Date.parse("2035-04-01T00:00:00Z")},1)`);
      await db.$executeRawUnsafe(`INSERT INTO "Shift" (id, employeeId, date, startAt, endAt, sourcePosition, board, importBatchId) VALUES ('s4s','s4e','2035-04-16',${Date.parse("2035-04-16T14:00:00Z")},${Date.parse("2035-04-16T22:00:00Z")},'Cocina','cocina','s4b')`);
      await db.$executeRawUnsafe(`INSERT INTO "Assignment" (id, shiftId, employeeId, stationId, hourStart, hourEnd) VALUES ('s4a','s4s','s4e','pdf_tq1r',${Date.parse("2035-04-16T17:00:00Z")},${Date.parse("2035-04-16T18:00:00Z")})`);
      const before = await db.$queryRawUnsafe<unknown[]>(`SELECT id, stationId, employeeId FROM "Assignment"`);
      await db.$disconnect();
      const push = run(["exec", "prisma", "db", "push", "--skip-generate"]);
      expect(push).not.toMatch(/accept-data-loss|data loss/i);
      expect(push).toMatch(/in sync|already in sync|Your database is now in sync/i);
      const afterDb = new PrismaClient({ datasources: { db: { url: dbUrl } } });
      const after = await afterDb.$queryRawUnsafe<Array<{ id: string; seatNumber: number | null }>>(
        `SELECT id, seatNumber FROM "Assignment"`,
      );
      expect(after).toEqual([{ id: "s4a", seatNumber: null }]);
      expect(before).toHaveLength(1);
      await afterDb.$disconnect();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
