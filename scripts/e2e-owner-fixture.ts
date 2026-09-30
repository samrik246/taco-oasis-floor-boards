/** Synthetic Playwright setup only. Production seeding never grants these roles. */
import "./test-db-guard.cjs";
import { PrismaClient } from "@prisma/client";
import { hashManagerCode } from "../src/lib/managers/codes";

async function main() {
  if (!process.env.FLOOR_BOARDS_TEST_ROOT) throw new Error("Disposable test root required");
  const db = new PrismaClient();
  try {
    await db.manager.updateMany({ where: { name: "Sam Chen" }, data: { role: "owner" } });
    await db.manager.create({ data: { name: "Synthetic Second Owner", codeHash: hashManagerCode("e2e-second-owner"), role: "owner" } });
  } finally { await db.$disconnect(); }
}
void main();
