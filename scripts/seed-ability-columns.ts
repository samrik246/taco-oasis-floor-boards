/**
 * Host install step. Writes the five Habilidades column settings only.
 * Prints counts. Never prints a name, and never writes an ability row.
 *
 * Usage: tsx scripts/seed-ability-columns.ts --manager-id <id>
 */
import { BOARD_CHANGE_ROUTES } from "../src/lib/board-change-log";
import { seedAbilityColumnSettings } from "../src/lib/abilities/column-settings";
import { prisma } from "../src/lib/db";

function managerId(): string | null {
  const index = process.argv.indexOf("--manager-id");
  if (index === -1) return null;
  const value = process.argv[index + 1]?.trim();
  return value ? value : null;
}

async function main() {
  const id = managerId();
  if (!id) {
    console.error("usage: tsx scripts/seed-ability-columns.ts --manager-id <id>");
    process.exitCode = 1;
    return;
  }
  const manager = await prisma.manager.findUnique({
    where: { id },
    select: { id: true, name: true, active: true },
  });
  if (!manager || !manager.active) {
    console.error(manager ? "inactive manager" : "unknown manager");
    process.exitCode = 1;
    return;
  }
  const counts = await seedAbilityColumnSettings({
    id: manager.id,
    name: manager.name,
    route: BOARD_CHANGE_ROUTES.abilityColumnSeed,
  });
  console.log(JSON.stringify(counts));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
