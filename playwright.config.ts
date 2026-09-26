import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;
const testRoot = mkdtempSync(join(realpathSync("/tmp"), "color-boards-test-"));
const testDb = join(testRoot, "e2e.db");
const databaseUrl = `file:${testDb}`;

/**
 * Fresh absolute SQLite under /private/tmp for e2e. The preload proves every
 * webServer child, including Prisma and Next, resolves to that database.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: [
      // Prisma on macOS needs the SQLite file to exist before `db push` opens it.
      `touch ${testDb}`,
      "pnpm db:setup",
      // Never serve a stale .next from an earlier source edit.
      "pnpm build",
      `pnpm exec next start -H 127.0.0.1 -p ${PORT}`,
    ].join(" && "),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      FLOOR_BOARDS_TEST_ROOT: testRoot,
      NODE_OPTIONS: `--require=${join(process.cwd(), "scripts/test-db-guard.cjs")}`,
      DEMO_MANAGER_CODES: "1",
      MANAGER_SESSION_SECRET: "playwright-manager-session-secret-000000",
      // Short idle so manager→staff timeout e2e stays fast
      MANAGER_IDLE_MS: "1500",
    },
  },
});
