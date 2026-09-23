/**
 * Synthetic When I Work schedule rows for C1 tests. Every person here is
 * invented; no row comes from a real export.
 */
import ExcelJS from "exceljs";
import type { PrismaClient } from "@prisma/client";
import { ALL_STATIONS } from "@/lib/stations";

export type SyntheticRow = {
  position: string;
  firstName: string;
  lastName: string;
  employeeId: string;
  date: string;
  start: string;
  end: string;
  email?: string;
};

const HEADER = [
  "Schedule",
  "Site",
  "Position",
  "First Name",
  "Last Name",
  "Employee ID",
  "Email",
  "Shift Start Date",
  "Shift Start Time",
  "Shift End Time",
  "Hourly Rate",
  "Status",
];

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function rowValues(r: SyntheticRow): string[] {
  return [
    "Test Schedule",
    "Test Site",
    r.position,
    r.firstName,
    r.lastName,
    r.employeeId,
    r.email ?? "",
    r.date,
    r.start,
    r.end,
    "0",
    "Published",
  ];
}

export function syntheticCsv(rows: SyntheticRow[]): Buffer {
  const lines = [HEADER, ...rows.map(rowValues)].map((cells) =>
    cells.map(csvCell).join(","),
  );
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/** xlsx with every Employee ID written as a text cell unless `numericIds` lists it. */
export async function syntheticXlsx(
  rows: SyntheticRow[],
  opts: { numericIds?: Array<{ id: string; numFmt?: string }> } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Schedules - Restaurant");
  ws.addRow(HEADER);
  const idCol = HEADER.indexOf("Employee ID") + 1;
  for (const r of rows) {
    const row = ws.addRow(rowValues(r));
    const numeric = opts.numericIds?.find((n) => n.id === r.employeeId);
    const cell = row.getCell(idCol);
    if (numeric) {
      cell.value = Number(r.employeeId);
      if (numeric.numFmt) cell.numFmt = numeric.numFmt;
    } else {
      cell.value = r.employeeId;
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function resetScheduleTables(prisma: PrismaClient): Promise<void> {
  await prisma.positionMoveLog.deleteMany();
  await prisma.assignment.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.employeeStationAbility.deleteMany();
  await prisma.tareaAssignment.deleteMany();
  await prisma.returnPrompt.deleteMany();
  await prisma.performanceAnswer.deleteMany();
  await prisma.employee.deleteMany();
  for (const s of ALL_STATIONS) {
    const data = {
      board: s.board,
      label: s.label,
      color: s.color,
      maxConcurrent: s.maxConcurrent,
      sortOrder: s.sortOrder,
      priority: s.priority,
    };
    await prisma.station.upsert({
      where: { id: s.id },
      create: { id: s.id, ...data },
      update: data,
    });
  }
}
