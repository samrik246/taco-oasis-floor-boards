import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import {
  resetScheduleTables,
  syntheticCsv,
  syntheticXlsx,
  type SyntheticRow,
} from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();

const person = (employeeId: string, date: string, firstName: string): SyntheticRow => ({
  position: "Caja - Regular",
  firstName,
  lastName: "Synthetic",
  employeeId,
  date,
  start: "9:00 am",
  end: "1:00 pm",
});

describe("A8: leading-zero IDs stay separate people across xlsx and CSV", () => {
  beforeAll(async () => {
    await resetScheduleTables(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("0042 and 42 import as two employees, and a later 0042 reuses the first", async () => {
    const xlsx = await syntheticXlsx([
      person("0042", "2030-02-04", "Ana"),
      person("42", "2030-02-04", "Beto"),
    ]);
    await persistImport(await parseScheduleWorkbook(xlsx, { filename: "d1.xlsx" }), "d1.xlsx");
    const csv = syntheticCsv([person("0042", "2030-02-05", "Ana")]);
    await persistImport(await parseScheduleWorkbook(csv, { filename: "d2.csv" }), "d2.csv");

    const employees = await prisma.employee.findMany({ orderBy: { externalId: "asc" } });
    expect(employees.map((e) => e.externalId)).toEqual(["0042", "42"]);
    const ana = employees.find((e) => e.externalId === "0042")!;
    expect(await prisma.shift.count({ where: { employeeId: ana.id } })).toBe(2);
  });
});
