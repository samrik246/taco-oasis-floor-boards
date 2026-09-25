const fs = require("node:fs");
const path = require("node:path");
const { safeDatabasePath } = require("./test-db-path.cjs");

async function main() {
  const expected = safeDatabasePath();
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe("PRAGMA database_list");
    const main = rows.find((row) => row.name === "main");
    const actual = main && path.resolve(String(main.file));
    if (actual !== expected) throw new Error("TEST_DB_PRISMA_PATH_MISMATCH");
    const root = process.env.FLOOR_BOARDS_TEST_ROOT;
    fs.appendFileSync(path.join(root, "database-paths.jsonl"), JSON.stringify({
      parentPid: process.ppid,
      command: path.basename(process.argv[2] || "node"),
      database: actual,
    }) + "\n");
    process.stdout.write(actual + "\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`test database probe refused: ${error.message}\n`);
  process.exitCode = 1;
});
