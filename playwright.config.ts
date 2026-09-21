import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * Fresh disposable SQLite for e2e — never touches prisma/dev.db.
 * Expects `pnpm build` already run (or builds in webServer).
 * webServer: wipe e2e.db → push+seed → next start on e2e DB.
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
      "rm -f prisma/e2e.db prisma/e2e.db-journal",
      'DATABASE_URL="file:./e2e.db" pnpm db:setup',
      // Build once if .next missing; reuse otherwise for speed
      "test -d .next || pnpm build",
      `DATABASE_URL="file:./e2e.db" pnpm exec next start -H 127.0.0.1 -p ${PORT}`,
    ].join(" && "),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      ...process.env,
      DATABASE_URL: "file:./e2e.db",
      // Short idle so manager→staff timeout e2e stays fast
      MANAGER_IDLE_MS: "1500",
    },
  },
});
