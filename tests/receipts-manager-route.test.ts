import { afterAll, beforeAll, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { signStaffSession } from "@/lib/breaks/session";
import { POST } from "@/app/api/receipts/route";

const prisma = new PrismaClient();
const name = `RECEIPT-OFFLINE-${Date.now()}`;
const prior = process.env.MANAGER_SESSION_SECRET;
let managerId = "", token = "";
beforeAll(async () => {
  process.env.MANAGER_SESSION_SECRET = "receipt-test-synthetic-secret-000000000";
  const row = await prisma.manager.create({ data: { name, codeHash: hashManagerCode(name), role: "manager", active: true } });
  managerId = row.id; token = signManagerSession(row);
});
afterAll(async () => { await prisma.manager.deleteMany({ where: { name } }); await prisma.$disconnect(); if (prior === undefined) delete process.env.MANAGER_SESSION_SECRET; else process.env.MANAGER_SESSION_SECRET = prior; });
function call(headers: Record<string, string> = {}) {
  return POST(new Request("http://local/api/receipts", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ schema: "receipt-browser/v1", request_id: "a".repeat(32), op: "read_defaults", args: {} }) }));
}
it("rejects absent, invalid and staff-only sessions; active manager reaches explicitly unavailable adapter", async () => {
  const headerCases: Record<string, string>[] = [{}, { "x-manager-session": "invalid" }, { "x-staff-session": signStaffSession({ employeeId: "synthetic", board: "caja" }) }];
  for (const headers of headerCases) {
    const res = await call(headers); expect(res.status).toBe(401); expect((await res.json()).reason).toBe("unauthorized");
  }
  const allowed = await call({ "x-manager-session": token }); expect(allowed.status).toBe(503);
  expect(await allowed.json()).toMatchObject({ state: "unavailable", reason: "runtime_unavailable", data: null });
  await prisma.manager.update({ where: { id: managerId }, data: { active: false } });
  const revoked = await call({ "x-manager-session": token }); expect(revoked.status).toBe(401);
});
