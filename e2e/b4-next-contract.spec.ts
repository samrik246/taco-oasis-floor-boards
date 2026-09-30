import path from "node:path";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { hashManagerCode } from "../src/lib/managers/codes";

test("paired gerente identity works from either tablet and an existing token loses authority on removal", async ({ request }) => {
  const root = process.env.FLOOR_BOARDS_TEST_ROOT;
  if (!root) throw new Error("Disposable test root required");
  const db = new PrismaClient({ datasources: { db: { url: `file:${path.join(root, "e2e.db")}` } } });
  const date = formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd");
  const code = "e2e-qualifying-gerente-code";
  const person = await db.employee.create({ data: { externalId: "e2e-b4next-gerente", firstName: "Synthetic", lastName: "Gerente" } });
  const shift = await db.shift.create({ data: { employeeId: person.id, board: "caja", date, sourcePosition: "Caja Manager", startAt: fromZonedTime(`${date}T15:00:00`, "America/Chicago"), endAt: fromZonedTime(`${date}T23:00:00`, "America/Chicago") } });
  const manager = await db.manager.create({ data: { name: "Synthetic Gerente", codeHash: hashManagerCode(code), employeeId: person.id } });
  try {
    const signin = await request.post("/api/breaks/session", { data: { board: "cocina", code } });
    expect(signin.status()).toBe(200);
    const body = await signin.json();
    expect(body.kind).toBe("gerente");
    const headers = { "x-manager-session": body.token };
    expect((await request.get(`/api/breaks/manage?board=caja&employeeId=${person.id}`, { headers })).status()).toBe(200);
    expect((await request.get("/api/boards/caja/days/2099-03-03", { headers })).status()).toBe(403);
    expect((await request.get("/api/admin/manager-pairings", { headers })).status()).toBe(403);
    await db.shift.update({ where: { id: shift.id }, data: { boardRemoved: true } });
    expect((await request.get(`/api/breaks/manage?board=caja&employeeId=${person.id}`, { headers })).status()).toBe(403);
  } finally {
    await db.manager.delete({ where: { id: manager.id } });
    await db.shift.delete({ where: { id: shift.id } });
    await db.employee.delete({ where: { id: person.id } });
    await db.$disconnect();
  }
});
