/**
 * Schedule import from a folder (C2). Takes the newest `Schedule_for_*` export in
 * FLOOR_BOARDS_IMPORT_DIR and runs it through the C1 preview and Confirm path.
 * FLOOR_BOARDS_IMPORT_MODE=hold (default) leaves a file that changes an
 * imported day for a manager's Confirm; =apply confirms it here.
 *
 * `pnpm exec tsx scripts/import-from-folder.ts`. Prints counts only.
 * Exit: 0 imported, 2 held for Confirm, 3 refused, 4 no export in the folder,
 * 1 error. This command schedules nothing; running it on a timer is the
 * owner's separate decision.
 */
import { prisma } from "../src/lib/db";
import {
  EXIT_CODES,
  formatSummary,
  runFolderImport,
  settingsFromEnv,
} from "../src/lib/import/folder-import";

async function main() {
  const settings = settingsFromEnv();
  const result = await runFolderImport(settings);
  console.log(`import-from-folder ${new Date().toISOString()}`);
  for (const line of formatSummary(result)) console.log(line);
  process.exitCode = EXIT_CODES[result.outcome];
}

main()
  .catch((error) => {
    // Error text only; no row data is attached to these errors.
    console.error(`import-from-folder error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
