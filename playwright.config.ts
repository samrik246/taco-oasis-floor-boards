import { defineConfig, devices } from "@playwright/test";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { closeSync, lstatSync, mkdtempSync, openSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/** 09:30 Chicago today, so a morning break is "now" on the read-only page. */
const e2eNow = fromZonedTime(
  `${formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd")}T09:30:00`,
  "America/Chicago",
).toISOString();

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;
// Playwright reloads this config in workers; keep the runner's database root.
// Validate an inherited root before the webServer command touches its DB file.
const tempBase = realpathSync("/tmp");
const inheritedRoot = process.env.FLOOR_BOARDS_TEST_ROOT;
if (inheritedRoot && (
  !isAbsolute(inheritedRoot) ||
  dirname(inheritedRoot) !== tempBase ||
  !/^color-boards-test-[A-Za-z0-9]+$/.test(basename(inheritedRoot)) ||
  realpathSync(inheritedRoot) !== inheritedRoot ||
  !statSync(inheritedRoot).isDirectory()
)) {
  throw new Error("FLOOR_BOARDS_TEST_ROOT must be a real disposable directory");
}
const testRoot = inheritedRoot || mkdtempSync(join(tempBase, "color-boards-test-"));
const testDb = join(testRoot, "e2e.db");
const databaseUrl = `file:${testDb}`;
process.env.FLOOR_BOARDS_TEST_ROOT = testRoot;

// Prisma needs a file on macOS. Exclusive creation refuses an existing link;
// config reloads may reuse only the regular file created by the runner.
try {
  closeSync(openSync(testDb, "wx", 0o600));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  const file = lstatSync(testDb);
  if (!file.isFile() || file.nlink !== 1) {
    throw new Error("Playwright database must be a regular file with one link");
  }
}

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
    launchOptions: { args: ["--host-resolver-rules=MAP floor-boards.test 127.0.0.1", "--no-proxy-server"] },
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: [
      "pnpm db:setup",
      "pnpm exec tsx scripts/e2e-owner-fixture.ts",
      "pnpm exec tsx scripts/quarter-migrate.ts",
      // Never serve a stale .next from an earlier source edit.
      "pnpm build",
      "pnpm exec tsx scripts/quarter-seal.ts",
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
      STAFF_PASSCODE_PEPPER: "playwright-staff-passcode-pepper-0000",
      FLOOR_BOARDS_E2E_NOW: e2eNow,
      // Short idle so manager→staff timeout e2e stays fast
      MANAGER_IDLE_MS: "1500",
    },
  },
});
