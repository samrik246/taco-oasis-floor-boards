const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { safeDatabasePath } = require("./test-db-path.cjs");

// NODE_OPTIONS preloads this in Vitest, its workers, pnpm, tsx and Prisma CLI.
// A fresh Prisma process checks SQLite's actual main-file path before any test code runs.
try {
  const preload = `--require=${__filename}`;
  if (!process.env.NODE_OPTIONS?.split(/\s+/).includes(preload)) {
    throw new Error("TEST_DB_GUARD_NOT_INHERITED_BY_CHILDREN");
  }
  safeDatabasePath();
  const probe = spawnSync(process.execPath, [path.join(__dirname, "test-db-probe.cjs"), path.basename(process.argv[1] || "node")], {
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
  });
  if (probe.status !== 0) throw new Error(probe.stderr.trim() || "TEST_DB_PROBE_FAILED");
  process.stderr.write(`test database path: ${probe.stdout.trim()}\n`);
} catch (error) {
  process.stderr.write(`test database guard refused: ${error.message}\n`);
  process.exit(78);
}
