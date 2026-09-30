import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { commitImport, previewImport } from "@/lib/import/persist-import";
import { createAssignment } from "@/lib/assignments/service";
import { removeShift, resolveMissingRemoval, restoreShift } from "@/lib/shifts/remove-restore";
import { GET as getDay } from "@/app/api/boards/[board]/days/[date]/route";
import { GET as getRemovals, POST as postRemoval } from "@/app/api/shift-removals/route";
import { signManagerSession } from "@/lib/managers/session";
import { chicagoDateTime } from "@/lib/time";
import { dbSnapshot, resetScheduleTables, syntheticCsv, type SyntheticRow } from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();
const date = "2030-06-03";
const nextDate = "2030-06-04";
const now = chicagoDateTime(date, "6:00 am");
const manager = { id: "shift-removal-test-manager", name: "Test Manager" };
const row = (start: string, end: string, employeeId = "5201", on = date): SyntheticRow => ({
  position: "Caja - Regular", firstName: employeeId === "5201" ? "Abril" : "Bruno",
  lastName: "Ejemplo", employeeId, date: on, start, end,
});
const split = [row("8:00 am", "10:00 am"), row("2:00 pm", "4:00 pm"),
  row("8:00 am", "10:00 am", "5202", nextDate)];
const parse = (rows: SyntheticRow[], filename: string) =>
  parseScheduleWorkbook(syntheticCsv(rows), { filename });

async function importRows(rows: SyntheticRow[], filename: string) {
  const parsed = await parse(rows, filename);
  const preview = await previewImport(parsed, { now });
  await commitImport(parsed, filename, { now,
    expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest } });
  return preview;
}

async function shifts() {
  return prisma.shift.findMany({ where: { employee: { externalId: "5201" }, date,
    supersededAt: null }, orderBy: { startAt: "asc" } });
}

async function removeFirst() {
  const first = (await shifts())[0]!;
  const result = await removeShift({ shiftId: first.id, board: "caja", date,
    expected: { startAt: first.startAt.toISOString(), endAt: first.endAt.toISOString(),
      employeeId: first.employeeId, sourcePosition: first.sourcePosition },
    expectedRevision: 0, reason: "Manager test removal", manager, now });
  return { first, result };
}

describe("manager shift removal and restoration on disposable data", () => {
  beforeEach(async () => {
    await resetScheduleTables(prisma);
    await prisma.manager.upsert({ where: { id: manager.id },
      create: { id: manager.id, name: manager.name, codeHash: "test-only", active: true, role: "owner" },
      update: { active: true, role: "owner" } });
    await commitImport(await parse(split, "first.csv"), "first.csv", { now });
  });
  afterAll(async () => {
    await prisma.manager.deleteMany({ where: { id: { in: [manager.id, "second-manager"] } } });
    await prisma.$disconnect();
  });

  it("hides only the selected split shift, clears future cells, keeps history and refuses direct staff mutation", async () => {
    const [first, second] = await shifts();
    const assigned = await createAssignment({ shiftId: first!.id, stationId: "green1", date, hour: 8, now });
    expect(assigned.ok).toBe(true);
    const { result } = await removeFirst();
    expect(result.removedCells).toBe(1);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: first!.id } })).boardRemoved).toBe(true);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: second!.id } })).boardRemoved).toBe(false);
    expect(await prisma.assignment.count({ where: { shiftId: first!.id } })).toBe(0);
    const hidden = await createAssignment({ shiftId: first!.id, stationId: "green1", date, hour: 8, now });
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.violations.map((v) => v.code)).toContain("SHIFT_REMOVED");

    const token = signManagerSession(manager);
    const dayResponse = await getDay(new Request(`http://local/api/boards/caja/days/${date}`,
      { headers: { "x-manager-session": token } }),
    { params: Promise.resolve({ board: "caja", date }) });
    const day = await dayResponse.json() as { shifts: Array<{ id: string }> };
    expect(day.shifts.map((s) => s.id)).not.toContain(first!.id);
    expect(day.shifts.map((s) => s.id)).toContain(second!.id);
    const history = await prisma.shiftRemovalEvent.findMany({ where: { overrideId: result.id } });
    expect(history).toMatchObject([{ action: "remove", managerId: manager.id,
      reason: "Manager test removal" }]);

    const anonymous = await postRemoval(new Request("http://local/api/shift-removals", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", id: result.id }),
    }));
    expect(anonymous.status).toBe(401);
  });

  it("keeps removal through duplicate and uniquely changed imports, then rejects stale preview", async () => {
    const { first, result } = await removeFirst();
    const beforeDuplicate = await dbSnapshot(prisma);
    await expect(commitImport(await parse(split, "same.csv"), "same.csv", { now }))
      .rejects.toMatchObject({ code: "DUPLICATE" });
    expect(await dbSnapshot(prisma)).toBe(beforeDuplicate);

    const changed = [row("8:00 am", "11:00 am"), split[1]!, split[2]!];
    const parsed = await parse(changed, "changed.csv");
    const preview = await previewImport(parsed, { now });
    expect(preview.refusals).toEqual([]);
    await commitImport(parsed, "changed.csv", { now,
      expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest } });
    const override = await prisma.shiftRemoval.findUniqueOrThrow({ where: { id: result.id } });
    expect(override.shiftId).toBe(first.id);
    expect(override.revision).toBe(2);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: first.id } })).boardRemoved).toBe(true);

    const later = await parse([row("8:00 am", "12:00 pm"), split[1]!, split[2]!], "later.csv");
    const stale = await previewImport(later, { now });
    const updated = await prisma.shiftRemoval.update({ where: { id: result.id },
      data: { revision: { increment: 1 } } });
    const before = await dbSnapshot(prisma);
    await expect(commitImport(later, "later.csv", { now,
      expected: { fingerprint: stale.fingerprint, planDigest: stale.planDigest } }))
      .rejects.toMatchObject({ code: "BOARD_CHANGED" });
    expect(await dbSnapshot(prisma)).toBe(before);
    expect(updated.revision).toBe(3);
  });

  it("refuses an ambiguous zero-overlap split import without writing", async () => {
    await removeFirst();
    const changed = [row("10:00 am", "12:00 pm"), row("4:00 pm", "6:00 pm"), split[2]!];
    const parsed = await parse(changed, "disjoint.csv");
    const preview = await previewImport(parsed, { now });
    expect(preview.refusals.map((r) => r.code)).toContain("REMOVAL_IDENTITY");
    const before = await dbSnapshot(prisma);
    await expect(commitImport(parsed, "disjoint.csv", { now,
      expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest } }))
      .rejects.toMatchObject({ code: "REFUSED" });
    expect(await dbSnapshot(prisma)).toBe(before);
  });

  it("keeps a missing-source tombstone and relinks an exact unique reappearance", async () => {
    const { result } = await removeFirst();
    await importRows([split[1]!, split[2]!], "missing.csv");
    expect((await prisma.shiftRemoval.findUniqueOrThrow({ where: { id: result.id } })).shiftId).toBeNull();
    const reappearing = [split[0]!, split[1]!, split[2]!,
      row("8:00 am", "9:00 am", "5203", nextDate)];
    await importRows(reappearing, "reappearing.csv");
    const override = await prisma.shiftRemoval.findUniqueOrThrow({ where: { id: result.id } });
    expect(override.shiftId).not.toBeNull();
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: override.shiftId! } })).boardRemoved).toBe(true);
    expect((await prisma.shiftRemovalEvent.findMany({ where: { overrideId: result.id },
      orderBy: { revision: "asc" } }))
      .map((e) => e.action)).toEqual(["remove", "source-missing", "relink"]);
  });

  it("lets a manager auditably release a missing-source tombstone before a changed source import", async () => {
    const { result } = await removeFirst();
    await importRows([split[1]!, split[2]!], "missing-for-resolution.csv");
    const changed = [row("9:00 am", "11:00 am"), split[1]!, split[2]!];
    const parsed = await parse(changed, "changed-after-missing.csv");
    const blocked = await previewImport(parsed, { now });
    expect(blocked.refusals.map((r) => r.code)).toContain("REMOVAL_IDENTITY");
    const before = await dbSnapshot(prisma);
    await expect(commitImport(parsed, "changed-after-missing.csv", { now,
      expected: { fingerprint: blocked.fingerprint, planDigest: blocked.planDigest } }))
      .rejects.toMatchObject({ code: "REFUSED" });
    expect(await dbSnapshot(prisma)).toBe(before);

    const tombstone = await prisma.shiftRemoval.findUniqueOrThrow({ where: { id: result.id } });
    const secondManager = { id: "second-manager", name: "Second Manager" };
    await prisma.manager.upsert({ where: { id: secondManager.id },
      create: { ...secondManager, codeHash: "test-only", active: true, role: "owner" }, update: { active: true, role: "owner" } });
    const response = await postRemoval(new Request("http://local/api/shift-removals", {
      method: "POST", headers: { "Content-Type": "application/json",
        "x-manager-session": signManagerSession(secondManager) },
      body: JSON.stringify({ action: "resolve", id: result.id,
        expectedRevision: tombstone.revision, reason: "New source is a different shift" }),
    }));
    expect(response.status).toBe(200);
    const resolved = await response.json() as { state: string; revision: number };
    expect(resolved).toMatchObject({ state: "resolved", revision: 3 });
    await expect(resolveMissingRemoval({ id: result.id, expectedRevision: tombstone.revision,
      reason: "Stale repeat", manager })).rejects.toMatchObject({ code: "REVISION_CHANGED" });
    const fresh = await previewImport(parsed, { now });
    expect(fresh.refusals).toEqual([]);
    await commitImport(parsed, "changed-after-missing.csv", { now,
      expected: { fingerprint: fresh.fingerprint, planDigest: fresh.planDigest } });
    const newShift = (await shifts()).find((s) =>
      s.startAt.getTime() === chicagoDateTime(date, "9:00 am").getTime());
    expect(newShift?.boardRemoved).toBe(false);
    const events = await prisma.shiftRemovalEvent.findMany({ where: { overrideId: result.id },
      orderBy: { revision: "asc" } });
    expect(events.map((e) => [e.action, e.revision])).toEqual([
      ["remove", 1], ["source-missing", 2], ["resolve", 3],
    ]);
    expect(events[2]!.managerId).toBe(secondManager.id);
  });

  it("preserves started history and replays only future cells with revision-bearing manager evidence", async () => {
    const [first] = await shifts();
    for (const hour of [8, 9]) {
      expect((await createAssignment({ shiftId: first!.id, stationId: "green1", date,
        hour, now })).ok).toBe(true);
    }
    const removalClock = chicagoDateTime(date, "8:30 am");
    const expected = { startAt: first!.startAt.toISOString(), endAt: first!.endAt.toISOString(),
      employeeId: first!.employeeId, sourcePosition: first!.sourcePosition };
    const removed = await removeShift({ shiftId: first!.id, board: "caja", date, expected,
      expectedRevision: 0, reason: "Split-shift correction", manager, now: removalClock });
    expect(removed.removedCells).toBe(1);
    const started = await prisma.assignment.findMany({ where: { shiftId: first!.id } });
    expect(started.map((a) => a.hourStart.toISOString())).toEqual([
      chicagoDateTime(date, "8:00 am").toISOString(),
    ]);
    const restored = await restoreShift({ id: removed.id, expectedRevision: removed.revision,
      expected, positions: "replay", reason: "Station is still free", manager, now: removalClock });
    expect(restored.restoredCells).toBe(1);
    const cells = await prisma.assignment.findMany({ where: { shiftId: first!.id },
      orderBy: { hourStart: "asc" } });
    expect(cells.map((a) => a.hourStart.toISOString())).toEqual([
      chicagoDateTime(date, "8:00 am").toISOString(),
      chicagoDateTime(date, "9:00 am").toISOString(),
    ]);
    expect(cells[0]!.id).toBe(started[0]!.id);

    const token = signManagerSession(manager);
    const response = await getRemovals(new Request(`http://local/api/shift-removals?board=caja&date=${date}`,
      { headers: { "x-manager-session": token } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { removals: Array<{ id: string; events: Array<{
      revision: number; source: { shiftId: string }; cells: unknown }> }> };
    const history = body.removals.find((r) => r.id === removed.id)!.events;
    expect(history.map((e) => e.revision)).toEqual([1, 2]);
    expect(history[0]!.source.shiftId).toBe(first!.id);
    expect(history[0]!.cells).toEqual([expect.objectContaining({ stationId: "green1" })]);
    expect(history[1]!.cells).toMatchObject({ positions: "replay",
      cells: [expect.objectContaining({ stationId: "green1" })] });
  });

  it("relinks a replaced source with positive unique overlap and keeps its old started history hidden", async () => {
    const [first] = await shifts();
    expect((await createAssignment({ shiftId: first!.id, stationId: "green1", date,
      hour: 8, now })).ok).toBe(true);
    const removalClock = chicagoDateTime(date, "8:30 am");
    const removed = await removeShift({ shiftId: first!.id, board: "caja", date,
      expected: { startAt: first!.startAt.toISOString(), endAt: first!.endAt.toISOString(),
        employeeId: first!.employeeId, sourcePosition: first!.sourcePosition },
      expectedRevision: 0, reason: "Remove first occurrence", manager, now: removalClock });
    const parsed = await parse([row("9:00 am", "11:00 am"), split[1]!, split[2]!], "replaced.csv");
    const preview = await previewImport(parsed, { now: removalClock });
    expect(preview.refusals).toEqual([]);
    expect(preview.dates[0]!.replaced).toBe(1);
    await commitImport(parsed, "replaced.csv", { now: removalClock,
      expected: { fingerprint: preview.fingerprint, planDigest: preview.planDigest } });
    const override = await prisma.shiftRemoval.findUniqueOrThrow({ where: { id: removed.id } });
    expect(override.shiftId).not.toBe(first!.id);
    expect(override.shiftId).not.toBeNull();
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: override.shiftId! } })).boardRemoved).toBe(true);
    const old = await prisma.shift.findUniqueOrThrow({ where: { id: first!.id }, include: { assignments: true } });
    expect(old.supersededAt).not.toBeNull();
    expect(old.boardRemoved).toBe(true);
    expect(old.assignments).toHaveLength(1);
    const events = await prisma.shiftRemovalEvent.findMany({ where: { overrideId: removed.id },
      orderBy: { revision: "asc" } });
    expect(events.map((e) => [e.action, e.revision])).toEqual([["remove", 1], ["relink", 2]]);
  });

  it("refuses a conflicting position replay atomically, then restores deliberately without positions", async () => {
    const [first] = await shifts();
    const assigned = await createAssignment({ shiftId: first!.id, stationId: "green1", date, hour: 8, now });
    expect(assigned.ok).toBe(true);
    const { result } = await removeFirst();
    const other = row("8:00 am", "10:00 am", "5202");
    await importRows([...split, other], "with-other.csv");
    const otherShift = await prisma.shift.findFirstOrThrow({ where: { date,
      employee: { externalId: "5202" }, supersededAt: null } });
    const occupied = await createAssignment({ shiftId: otherShift.id, stationId: "green1", date, hour: 8, now });
    expect(occupied.ok).toBe(true);
    const override = await prisma.shiftRemoval.findUniqueOrThrow({ where: { id: result.id } });
    const expected = { startAt: first!.startAt.toISOString(), endAt: first!.endAt.toISOString(),
      employeeId: first!.employeeId, sourcePosition: first!.sourcePosition };
    const before = await dbSnapshot(prisma);
    await expect(restoreShift({ id: result.id, expectedRevision: override.revision, expected,
      positions: "replay", reason: "Try to restore", manager, now }))
      .rejects.toMatchObject({ code: "POSITION_CONFLICT" });
    expect(await dbSnapshot(prisma)).toBe(before);
    const restored = await restoreShift({ id: result.id, expectedRevision: override.revision, expected,
      positions: "none", reason: "Repaint manually", manager, now });
    expect(restored.restoredCells).toBe(0);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: first!.id } })).boardRemoved).toBe(false);
    expect(await prisma.assignment.count({ where: { shiftId: first!.id } })).toBe(0);
    await expect(restoreShift({ id: result.id, expectedRevision: override.revision, expected,
      positions: "none", reason: "Repeat", manager, now }))
      .rejects.toMatchObject({ code: "REVISION_CHANGED" });
  });
});
