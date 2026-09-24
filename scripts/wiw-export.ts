/**
 * When I Work schedule export for the floor boards (B2), run by a LaunchAgent
 * at 07:00 and 16:00 on the boards Mac. No AI agent is in the loop.
 *
 * Carve-out (CB-006): This job only: a timer on T MAC MINI may export the
 * current Friday-through-Thursday When I Work schedule into the floor boards.
 * The weekly schedule skill, the weekly timesheet skill, and the LOLA360 daily
 * export stay supervised on Rich's Mac, one person-started run at a time.
 *
 * Each run: delete a workbook a held run left behind; open the scheduler in
 * this job's own Chromium folder (headed); sign in from the locked login file
 * only if the sign-in page is up; export this Friday through Thursday; rename
 * it to `Schedule_for_<friday>_<thursday>.xlsx` in FLOOR_BOARDS_IMPORT_DIR;
 * run the folder import in hold mode; delete the workbook unless it is held
 * for a manager's Confirm (the next run deletes it). A sign-in it cannot pass,
 * a code, a CAPTCHA or a changed page stops the run (LOGIN, MFA, CAPTCHA,
 * PAGE) and the board keeps the last import.
 *
 * Settings: FLOOR_BOARDS_IMPORT_DIR, WIW_LOGIN_FILE, WIW_BROWSER_PROFILE, all
 * absolute. The log is var/log/wiw-export.log: codes, counts and the file
 * name only.
 *
 * `node node_modules/tsx/dist/cli.mjs scripts/wiw-export.ts` (the timer's line;
 * `pnpm exec tsx` fails in the installed release folder)
 *   Exit: 0 imported, 2 held for Confirm, 3 refused, 4 no export, 5 stopped
 *   (LOGIN/MFA/CAPTCHA/PAGE), 1 error.
 * `… scripts/wiw-export.ts --sign-in`
 *   Opens this job's browser folder at the scheduler for a person to sign in
 *   by hand (and pass a code once). Reads no login file, exports nothing.
 *   Close the window when the scheduler shows.
 * `… scripts/wiw-export.ts --launch-agent-template`
 *   Writes var/run/com.taco-oasis.wiw-export.plist. Does not load it.
 * `… scripts/wiw-export.ts --mode probe-dialog`
 *   The run's steps up to the Export Schedule click, then an ARIA snapshot of
 *   the dialog (or the page) to var/log/wiw-probe-*.aria.yml, mode 600, and
 *   the controls' roles and names to the log. Never clicks Export, saves or
 *   imports nothing, writes no timer. Exit: 6 captured, 5 stopped, 1 error.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { playwrightExporter, SCHEDULER_URL } from "../src/lib/wiw-export/browser";
import { launchAgentPlist, WIW_EXPORT_LABEL } from "../src/lib/wiw-export/launch-agent";
import { readLoginFile } from "../src/lib/wiw-export/login-file";
import { runProbeDialog } from "../src/lib/wiw-export/probe";
import { runWiwExport, SettingsError, wiwSettingsFromEnv } from "../src/lib/wiw-export/run";

const appDir = path.resolve(__dirname, "..");

async function signInByHand() {
  const { profileDir } = wiwSettingsFromEnv(appDir);
  const { chromium } = await import("@playwright/test");
  const context = await chromium.launchPersistentContext(profileDir, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(SCHEDULER_URL);
  console.log("wiw-export sign-in: sign in in the window, then close it.");
  await new Promise<void>((resolve) => context.on("close", () => resolve()));
}

async function writeTemplate() {
  const s = wiwSettingsFromEnv(appDir);
  const out = path.join(appDir, "var", "run", `${WIW_EXPORT_LABEL}.plist`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(
    out,
    launchAgentPlist({
      appDir,
      nodePath: process.execPath,
      importDir: s.importDir,
      loginFile: s.loginFile,
      profileDir: s.profileDir,
    }),
  );
  console.log(`Generated ${out} (not loaded).`);
}

async function probeDialog() {
  const settings = wiwSettingsFromEnv(appDir);
  const result = await runProbeDialog(settings, {
    exporter: (probe) => playwrightExporter({ profileDir: settings.profileDir, probe }),
    readLogin: () =>
      readLoginFile(settings.loginFile, {
        keepOut: [settings.appDir, settings.importDir, settings.profileDir],
      }),
  });
  process.exitCode = result.exitCode;
}

async function main() {
  const [arg, value, extra] = process.argv.slice(2);
  if (arg === "--sign-in") return signInByHand();
  if (arg === "--launch-agent-template") return writeTemplate();
  if (arg === "--mode" && value === "probe-dialog" && extra === undefined) return probeDialog();
  if (arg !== undefined) throw new SettingsError("UNKNOWN_ARGUMENT");

  const settings = wiwSettingsFromEnv(appDir);
  const result = await runWiwExport(settings, {
    exporter: playwrightExporter({ profileDir: settings.profileDir }),
    readLogin: () =>
      readLoginFile(settings.loginFile, {
        keepOut: [settings.appDir, settings.importDir, settings.profileDir],
      }),
  });
  process.exitCode = result.exitCode;
}

main()
  .catch((error) => {
    // A code only: no row data, no login field, no page text.
    const code = error instanceof SettingsError ? error.code : "RUN";
    const line = `${new Date().toISOString()} wiw-export error=${code}`;
    console.error(line);
    process.exitCode = 1;
    if (process.argv[2] === undefined || process.argv[2] === "--mode") {
      const log = path.join(appDir, "var", "log", "wiw-export.log");
      return mkdir(path.dirname(log), { recursive: true })
        .then(() => appendFile(log, `${line}\n`))
        .catch(() => undefined);
    }
  })
  .finally(() => prisma.$disconnect());
