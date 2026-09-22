import { PrismaClient } from "@prisma/client";
import { managerSessionIsConfigured } from "../src/lib/managers/session";

const prisma = new PrismaClient();

async function main() {
  if (!managerSessionIsConfigured()) {
    throw new Error("Home base is not initialized: MANAGER_SESSION_SECRET is absent or invalid.");
  }
  const [managers, caja, cocina, templates] = await Promise.all([
    prisma.manager.count({ where: { active: true } }),
    prisma.station.count({ where: { board: "caja" } }),
    prisma.station.count({ where: { board: "cocina" } }),
    prisma.tareaTemplate.count(),
  ]);
  if (managers < 1 || caja < 1 || cocina < 1 || templates < 1) {
    throw new Error(
      `Home base is not initialized (active managers=${managers}, caja stations=${caja}, cocina stations=${cocina}, templates=${templates}).`,
    );
  }
  console.log(`Ready: ${managers} manager(s), ${caja} caja stations, ${cocina} cocina stations, ${templates} tarea templates.`);
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
