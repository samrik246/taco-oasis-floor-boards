import { defineConfig, devices } from "@playwright/test";
import { closeSync, mkdtempSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * T4G Imprimir on the real app, opt-in (check 8). Needs a packing-ticket
 * checkout on quinn/t4g-imprimir-pt and its Python:
 *   T4G_PRINT_TEST_DIR=/abs/checkout T4G_PRINT_TEST_PYTHON=/abs/.venv/bin/python \
 *     pnpm exec playwright test -c playwright.t4g-print.config.ts
 * globalSetup starts a fake Epson on 127.0.0.1 and writes the packing-ticket
 * config for it; no real printer is addressed. The main e2e suite is untouched.
 * The server reads fixtures/square-next/orders.json, so AgIeZY must still be
 * dated today or later on the Chicago clock (15 Oct 2026).
 */
const dir = process.env.T4G_PRINT_TEST_DIR ?? "";
const python = process.env.T4G_PRINT_TEST_PYTHON ?? "";
if (!isAbsolute(dir) || !isAbsolute(python)) {
  throw new Error("Set absolute T4G_PRINT_TEST_DIR and T4G_PRINT_TEST_PYTHON");
}

const PORT = 3101;
const baseURL = `http://127.0.0.1:${PORT}`;
const tempBase = realpathSync("/tmp");
const testRoot = process.env.T4G_PRINT_E2E_ROOT || mkdtempSync(join(tempBase, "color-boards-test-"));
process.env.T4G_PRINT_E2E_ROOT = testRoot;
process.env.FLOOR_BOARDS_TEST_ROOT = testRoot;
const testDb = join(testRoot, "e2e.db");
try {
  closeSync(openSync(testDb, "wx", 0o600));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}

export default defineConfig({
  testDir: "./e2e-t4g-print",
  globalSetup: "./e2e-t4g-print/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL, ...devices["Desktop Chrome"] },
  webServer: {
    command: ["pnpm db:setup", "pnpm build", `pnpm exec next start -H 127.0.0.1 -p ${PORT}`].join(" && "),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      ...process.env,
      DATABASE_URL: `file:${testDb}`,
      FLOOR_BOARDS_TEST_ROOT: testRoot,
      NODE_OPTIONS: `--require=${join(process.cwd(), "scripts/test-db-guard.cjs")}`,
      DEMO_MANAGER_CODES: "1",
      MANAGER_SESSION_SECRET: "playwright-manager-session-secret-000000",
      STAFF_PASSCODE_PEPPER: "playwright-staff-passcode-pepper-0000",
      NEXT_SOURCE: "fixture",
      T4G_PRINT: "on",
      T4G_PRINT_PYTHON: python,
      T4G_PRINT_DIR: dir,
      T4G_PRINT_CONFIG: join(testRoot, "three_part.json"),
      T4G_PRINT_MODEL_SOURCE: "fixture",
    },
  },
});
