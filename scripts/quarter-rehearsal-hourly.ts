/** Disposable provider; the real timer has no environment switch to select it. */
import { writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import { prisma } from "../src/lib/db";
import { assertSyntheticDatabase } from "../src/lib/quarter/test-boundary";
import { assertLoadedArtifactIdentity, loadedArtifactSha256 } from "../src/lib/quarter/artifact";
import { runScheduledExport } from "../src/lib/wiw-export/scheduled-run";
import { wiwSettingsFromEnv } from "../src/lib/wiw-export/run";
import { expectedDownloadName, type ExportWeek } from "../src/lib/wiw-export/week";
import { canonical } from "../src/lib/quarter/schema";

async function main() {
  const date = z.iso.date().parse(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  await assertSyntheticDatabase(prisma);
  assertLoadedArtifactIdentity(true);
  const root = await realpath(process.env.FLOOR_BOARDS_TEST_ROOT!);
  if (!(await realpath(path.dirname(output))).startsWith(root + path.sep)) throw new Error("HOURLY_EVIDENCE_OUTSIDE_TEST_ROOT");
  const calls: string[] = [];
  async function download(week: ExportWeek) {
    calls.push(`export:${week.friday}`);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Schedules - Synthetic");
    sheet.addRow(["Schedule", "Site", "Position", "First Name", "Last Name", "Employee ID", "Email", "Shift Start Date", "Shift Start Time", "Shift End Time", "Hourly Rate", "Status"]);
    for (const day of [week.friday, week.thursday]) sheet.addRow(["Synthetic", "Synthetic", "Caja - Regular", "Synthetic", "Hourly", "synthetic-hourly", "", day, "1:00 pm", "2:00 pm", "0", "Published"]);
    return {
      suggestedName: expectedDownloadName(week),
      saveAs: async (target: string) => { await workbook.xlsx.writeFile(target); },
      discard: async () => {},
    };
  }
  const settings = wiwSettingsFromEnv(path.resolve(__dirname, ".."));
  if (!(await realpath(settings.importDir)).startsWith(root + path.sep)) throw new Error("HOURLY_IMPORT_OUTSIDE_TEST_ROOT");
  const result = await runScheduledExport(settings, async () => {
    await writeFile(output + ".provider-started", canonical({ pid: process.pid, loadedArtifactSha256 }), { flag: "wx" });
    return {
      now: () => new Date(`${date}T18:00:00.000Z`),
      exporter: { exportWeek: download, exportNextWeek: download, close: async () => { calls.push("close"); } },
      readLogin: async () => { throw new Error("SYNTHETIC_PROVIDER_MUST_NOT_READ_LOGIN"); },
    };
  });
  await writeFile(output, canonical({ pid: process.pid, loadedArtifactSha256, calls, result }) + "\n", { flag: "wx" });
  console.log(canonical({ result, providerCalls: calls }));
  process.exitCode = result.exitCode;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
