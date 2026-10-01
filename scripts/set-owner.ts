import { PrismaClient } from "../src/lib/prisma-client";

/**
 * Host install step. Sets one active manager to owner.
 * Prints id and role only — never a name or a code.
 *
 * Usage: tsx scripts/set-owner.ts --manager-id <id>
 */
const prisma = new PrismaClient();

function managerId(): string | null {
  const index = process.argv.indexOf("--manager-id");
  if (index === -1) return null;
  const value = process.argv[index + 1]?.trim();
  return value ? value : null;
}

async function main() {
  const id = managerId();
  if (!id) {
    console.error("usage: tsx scripts/set-owner.ts --manager-id <id>");
    process.exitCode = 1;
    return;
  }
  const row = await prisma.manager.findUnique({
    where: { id },
    select: { id: true, active: true },
  });
  if (!row) {
    console.error("unknown manager");
    process.exitCode = 1;
    return;
  }
  if (!row.active) {
    console.error("inactive manager");
    process.exitCode = 1;
    return;
  }
  await prisma.manager.update({
    where: { id: row.id },
    data: { role: "owner" },
  });
  console.log(`${row.id} owner`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "set-owner failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
