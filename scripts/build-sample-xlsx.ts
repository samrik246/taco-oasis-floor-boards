/**
 * Build fixtures/wheniwork-restaurant-export-sample.xlsx from the in-repo CSV
 * pair so ExcelJS parser tests have a real workbook (SPEC / docs/FIXTURES.md).
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

async function csvToSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  csvPath: string,
) {
  const text = fs.readFileSync(csvPath, "utf8");
  const temp = new ExcelJS.Workbook();
  await temp.csv.read(Readable.from([text]));
  const src = temp.worksheets[0];
  if (!src) throw new Error(`No worksheet from ${csvPath}`);
  const dest = workbook.addWorksheet(sheetName);
  src.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = row.values;
    dest.getRow(rowNumber).values = values as ExcelJS.CellValue[];
  });
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const schedulesCsv = path.join(root, "fixtures", "schedules-restaurant.csv");
  const hourlyCsv = path.join(root, "fixtures", "hourly-restaurant.csv");
  const out = path.join(root, "fixtures", "wheniwork-restaurant-export-sample.xlsx");

  const workbook = new ExcelJS.Workbook();
  await csvToSheet(workbook, "Schedules - Restaurant", schedulesCsv);
  await csvToSheet(workbook, "Hourly - Restaurant", hourlyCsv);
  await workbook.xlsx.writeFile(out);
  console.log(`Wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
