import type { PrismaClient } from "@prisma/client";

/**
 * One UPDATE: set every stored Employee.email to null. Returns the number of
 * rows it changed. It never reads the column, and touches no other column
 * (a raw statement, so `updatedAt` stays as it was). A second run returns 0.
 */
export async function clearEmployeeEmails(prisma: PrismaClient): Promise<number> {
  return prisma.$executeRaw`UPDATE "Employee" SET "email" = NULL WHERE "email" IS NOT NULL`;
}
