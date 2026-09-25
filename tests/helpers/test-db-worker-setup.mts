import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

const require = createRequire(import.meta.url);
const { safeDatabasePath } = require("../../scripts/test-db-path.cjs") as {
  safeDatabasePath: () => string;
};

// Vitest awaits setupFiles before importing each test file. Check the worker's
// own Prisma connection here, not just the parent runner's environment.
const expected = safeDatabasePath();
const prisma = new PrismaClient();
try {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>("PRAGMA database_list");
  const main = rows.find((row) => row.name === "main");
  const actual = main && path.resolve(main.file);
  if (actual !== expected) throw new Error("TEST_DB_WORKER_PATH_MISMATCH");
  fs.appendFileSync(path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "worker-database-paths.jsonl"), JSON.stringify({
    pid: process.pid,
    workerId: process.env.VITEST_WORKER_ID ?? "preflight",
    database: actual,
  }) + "\n");
} finally {
  await prisma.$disconnect();
}
