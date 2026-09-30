import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { saveBreak } from "@/lib/breaks/rules";
import { approvalPreview } from "@/lib/breaks/preview";
import { dropImportedBreaks } from "@/lib/breaks/import-drop";
import { loadMyBreak } from "@/lib/breaks/mine";
import { chicagoDateTime } from "@/lib/time";

const db = new PrismaClient();
const date = "2044-06-08";
const at = (time: string) => chicagoDateTime(date, time);
const tag = `b4-reservation-${Date.now()}`;
const ids: string[] = [];

async function seat(stationId: string) {
  const person = await db.employee.create({ data: { externalId: `${tag}-${stationId}`, firstName: stationId, lastName: "Synthetic" } });
  ids.push(person.id);
  const shift = await db.shift.create({ data: { employeeId: person.id, date, board: "cocina", sourcePosition: "Cocina", startAt: at("8:00 am"), endAt: at("8:00 pm") } });
  await db.assignment.create({ data: { employeeId: person.id, shiftId: shift.id, stationId, hourStart: at("2:00 pm"), hourEnd: at("3:00 pm") } });
  return { person, shift };
}

describe("numbered reservation transaction and invalidation", () => {
  afterAll(async () => {
    await db.staffBreak.deleteMany({ where: { date } });
    await db.assignment.deleteMany({ where: { employeeId: { in: ids } } });
    await db.shift.deleteMany({ where: { employeeId: { in: ids } } });
    await db.employee.deleteMany({ where: { id: { in: ids } } });
    await db.boardChangeLog.deleteMany({ where: { date } });
    await db.$disconnect();
  });
  it("agrees with preview, rejects a cover's overlapping break, and returns to pending after cover removal", async () => {
    const people = new Map<string, Awaited<ReturnType<typeof seat>>>();
    for (const station of [...MANDATORY_STATIONS_BY_BOARD.cocina, "pdf_tq2r"]) people.set(station, await seat(station));
    const asker = people.get("pdf_tq1r")!;
    const cover = people.get("pdf_tq2r")!;
    const startAt = at("2:00 pm"), endAt = at("2:15 pm");
    const preview = await approvalPreview(date, "cocina", asker.person.id);
    expect(preview(startAt, endAt)).toBe("automatic");
    const beforePaint = await db.assignment.findMany({ where: { employeeId: { in: ids } }, orderBy: { id: "asc" } });
    const saved = await saveBreak({ employeeId: asker.person.id, date, startAt, endAt });
    expect(saved.status).toBe("booked");
    expect(await db.staffBreak.findUnique({ where: { id: saved.id } })).toMatchObject({ coverEmployeeId: cover.person.id, coverShiftId: cover.shift.id, auto: false });
    await expect(saveBreak({ employeeId: cover.person.id, date, startAt, endAt })).rejects.toMatchObject({ code: "BAD_COVER" });
    expect(await db.assignment.findMany({ where: { employeeId: { in: ids } }, orderBy: { id: "asc" } })).toEqual(beforePaint);
    await db.shift.update({ where: { id: cover.shift.id }, data: { boardRemoved: true } });
    await db.$transaction(tx => dropImportedBreaks(tx, { boardRemovedShiftIds: [cover.shift.id], changedShiftIds: [], supersededShiftIds: [] }));
    expect(await db.staffBreak.findUnique({ where: { id: saved.id } })).toMatchObject({ status: "pending", coverEmployeeId: null, coverShiftId: null, auto: false });
    const worker = await loadMyBreak({ employeeId: asker.person.id, board: "caja", exp: Date.now() + 60000 }, at("1:00 pm"));
    expect(worker.saved).toMatchObject({ status: "pending", approval: "gerente" });
    expect(worker.slots.find(s => s.startAt === startAt.toISOString() && s.endAt === endAt.toISOString())?.approval).toBe("gerente");
  });
});
