/**
 * One-time clear of staff emails already stored by earlier imports (Rich 3A).
 * Run once, after this release is the running app and after the pre-release
 * backup: `pnpm exec tsx scripts/clear-employee-emails.ts`. Prints the count
 * only. The column stays in the schema.
 */
import { PrismaClient } from "@prisma/client";
import { clearEmployeeEmails } from "../src/lib/employees/clear-emails";

const prisma = new PrismaClient();

clearEmployeeEmails(prisma)
  .then((count) => {
    console.log(`Cleared employee emails: ${count}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
