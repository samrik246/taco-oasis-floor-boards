import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { createAssignment } from "@/lib/assignments/service";
import { getEmployeeWeekHours } from "@/lib/ledger";
import { PUT as putAssignment } from "@/app/api/assignments/route";
import { resetScheduleTables, syntheticCsv, type SyntheticRow } from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();
const D = "2030-05-06";

const row = (employeeId: string, firstName: string, start: string, end: string): SyntheticRow => ({
  position: "Caja - Regular",
  firstName,
  lastName: "Demo",
  employeeId,
  date: D,
  start,
  end,
});

async function shiftOf(externalId: string, startAfter?: Date) {
  return prisma.shift.findFirstOrThrow({
    where: {
      employee: { externalId },
      ...(startAfter ? { startAt: { gte: startAfter } } : {}),
    },
    orderBy: { startAt: "asc" },
  });
}

describe("A2: ledger minutes are the overlap of the assigned hour with the shift", () => {
  beforeAll(async () => {
    await resetScheduleTables(prisma);
    const csv = syntheticCsv([
      row("5101", "Joel", "4:00 pm", "4:30 pm"),
      row("5102", "Karla", "9:30 am", "1:00 pm"),
      row("5103", "Leo", "5:00 pm", "9:15 pm"),
      row("5104", "Mora", "8:00 am", "12:00 pm"),
      // One person, split shift: 8–10 and 3:30–5.
      row("5105", "Nico", "8:00 am", "10:00 am"),
      row("5105", "Nico", "3:30 pm", "5:00 pm"),
    ]);
    await persistImport(await parseScheduleWorkbook(csv, { filename: "a2.csv" }), "a2.csv");
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("16:00–16:30 shift, hour 16 → 30 min", async () => {
    const sh = await shiftOf("5101");
    const r = await createAssignment({ shiftId: sh.id, stationId: "green1", date: D, hour: 16 });
    expect(r.ok).toBe(true);
    const ledger = await getEmployeeWeekHours(sh.employeeId, D);
    expect(ledger!.totalMinutes).toBe(30);
  });

  it("shift from 09:30: hour 9 is assignable through the API and counts 30 min", async () => {
    const sh = await shiftOf("5102");
    const res = await putAssignment(
      new Request("http://local/api/assignments", {
        method: "PUT",
        body: JSON.stringify({ shiftId: sh.id, stationId: "green2", date: D, hour: 9 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const r10 = await createAssignment({ shiftId: sh.id, stationId: "green2", date: D, hour: 10 });
    expect(r10.ok).toBe(true);
    const ledger = await getEmployeeWeekHours(sh.employeeId, D);
    expect(ledger!.totalMinutes).toBe(30 + 60);
  });

  it("shift ending 21:15, hour 21 → 15 min", async () => {
    const sh = await shiftOf("5103");
    const r = await createAssignment({ shiftId: sh.id, stationId: "yellow", date: D, hour: 21 });
    expect(r.ok).toBe(true);
    expect((await getEmployeeWeekHours(sh.employeeId, D))!.totalMinutes).toBe(15);
  });

  it("whole-hour shifts unchanged; hour past the shift end is refused", async () => {
    const sh = await shiftOf("5104");
    for (const h of [8, 9]) {
      expect((await createAssignment({ shiftId: sh.id, stationId: "blue", date: D, hour: h })).ok).toBe(true);
    }
    const past = await createAssignment({ shiftId: sh.id, stationId: "blue", date: D, hour: 12 });
    expect(past.ok).toBe(false);
    expect((await getEmployeeWeekHours(sh.employeeId, D))!.totalMinutes).toBe(120);
  });

  it("week total = sum of station rows, across a split shift", async () => {
    const early = await shiftOf("5105");
    const late = await shiftOf("5105", new Date(early.endAt.getTime() + 1));
    expect(late.id).not.toBe(early.id);
    expect((await createAssignment({ shiftId: early.id, stationId: "purple1", date: D, hour: 9 })).ok).toBe(true);
    expect((await createAssignment({ shiftId: late.id, stationId: "purple1", date: D, hour: 15 })).ok).toBe(true);
    expect((await createAssignment({ shiftId: late.id, stationId: "purple2", date: D, hour: 16 })).ok).toBe(true);
    // Hour 10 is back-to-back after the 8–10 shift: refused.
    expect((await createAssignment({ shiftId: early.id, stationId: "purple2", date: D, hour: 10 })).ok).toBe(false);
    const ledger = (await getEmployeeWeekHours(early.employeeId, D))!;
    expect(ledger.totalMinutes).toBe(60 + 30 + 60);
    expect(ledger.byStation.reduce((s, r) => s + r.minutes, 0)).toBe(ledger.totalMinutes);
  });
});
