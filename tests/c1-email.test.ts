import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { parseScheduleWorkbook } from "@/lib/parser/schedule-parser";
import { persistImport } from "@/lib/import/persist-import";
import { clearEmployeeEmails } from "@/lib/employees/clear-emails";
import { resetScheduleTables, syntheticCsv } from "./helpers/synthetic-schedule";

const prisma = new PrismaClient();

describe("A13 / A13b: staff email is never imported, and stored emails clear once", () => {
  beforeAll(async () => {
    await resetScheduleTables(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("A13: parser output has no email field; import stores none, keeps names, strips pay", async () => {
    const buf = syntheticCsv([
      {
        position: "Caja - Regular",
        firstName: "Rosa",
        lastName: "Inventada",
        employeeId: "9001",
        email: "rosa@example.invalid",
        date: "2030-03-04",
        start: "9:00 am",
        end: "1:00 pm",
      },
    ]);
    const parsed = await parseScheduleWorkbook(buf, { filename: "a13.csv" });
    expect(parsed.strippedPayColumns).toEqual(["Hourly Rate"]);
    for (const s of parsed.shifts) {
      expect(Object.keys(s)).not.toContain("email");
      expect(JSON.stringify(s)).not.toContain("example.invalid");
    }
    // A stored email from an earlier release must not be rewritten by an import either.
    await prisma.employee.create({
      data: { externalId: "9001", firstName: "Old", lastName: "Name", email: "old@example.invalid" },
    });
    await persistImport(parsed, "a13.csv");
    const emp = await prisma.employee.findUniqueOrThrow({ where: { externalId: "9001" } });
    expect(emp.firstName).toBe("Rosa");
    expect(emp.lastName).toBe("Inventada");
    expect(emp.email).toBe("old@example.invalid");
    const fresh = await prisma.employee.count({ where: { email: "rosa@example.invalid" } });
    expect(fresh).toBe(0);
  });

  it("A13b: clear leaves 0 emails, returns the seeded count, changes nothing else; second run 0", async () => {
    await resetScheduleTables(prisma);
    for (let i = 0; i < 3; i++) {
      await prisma.employee.create({
        data: { externalId: `95${i}`, firstName: `F${i}`, lastName: "L", email: `p${i}@example.invalid` },
      });
    }
    await prisma.employee.create({ data: { externalId: "959", firstName: "N", lastName: "L" } });
    const before = await prisma.employee.findMany({ orderBy: { externalId: "asc" } });

    expect(await clearEmployeeEmails(prisma)).toBe(3);
    const after = await prisma.employee.findMany({ orderBy: { externalId: "asc" } });
    expect(after.filter((e) => e.email !== null)).toHaveLength(0);
    expect(after.map(({ email: _e, ...rest }) => rest)).toEqual(
      before.map(({ email: _e, ...rest }) => rest),
    );
    expect(await clearEmployeeEmails(prisma)).toBe(0);
  });

  it("A13b: the script prints the count only", async () => {
    await prisma.employee.update({ where: { externalId: "950" }, data: { email: "again@example.invalid" } });
    const out = execFileSync("pnpm", ["exec", "tsx", "scripts/clear-employee-emails.ts"], {
      env: { ...process.env },
      encoding: "utf8",
    });
    expect(out.trim()).toBe("Cleared employee emails: 1");
    const second = execFileSync("pnpm", ["exec", "tsx", "scripts/clear-employee-emails.ts"], {
      env: { ...process.env },
      encoding: "utf8",
    });
    expect(second.trim()).toBe("Cleared employee emails: 0");
  });
});
