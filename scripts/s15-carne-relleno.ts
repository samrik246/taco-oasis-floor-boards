import { PrismaClient } from "../src/lib/prisma-client";
import {
  applyCarneRelleno,
  CarneRellenoConflict,
  formatCarneRellenoReport,
} from "../src/lib/s15-carne-relleno";

async function main() {
  const prisma = new PrismaClient();
  try {
    const report = await applyCarneRelleno(prisma);
    console.log(formatCarneRellenoReport(report));
  } catch (error) {
    if (error instanceof CarneRellenoConflict) {
      console.log(formatCarneRellenoReport(error.report));
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("s15-carne-relleno.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
