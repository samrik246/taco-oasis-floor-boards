import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { routePositionToBoard, positionStationHint } from "../board-routing";
import {
  HOURLY_SHEET_NAME,
  PAY_COLUMNS,
  SCHEDULES_SHEET_NAME,
  type BoardKind,
} from "../constants";
import { chicagoDateTime, isValidYmd } from "../time";

export type ParsedShift = {
  externalId: string;
  firstName: string;
  lastName: string;
  date: string;
  startAt: Date;
  endAt: Date;
  sourcePosition: string;
  board: BoardKind;
  stationHint: string | null;
};

export type ParseResult = {
  shifts: ParsedShift[];
  bucketCounts: { caja: number; cocina: number; other: number };
  dates: string[];
  /** True when pay-related columns were present in the header and ignored */
  strippedPayColumns: string[];
  /** Rows with no Employee ID (open shifts), skipped and counted per date. */
  skippedOpenShifts?: Record<string, number>;
};

type RawRow = Record<string, string>;

const REQUIRED_HEADERS = [
  "Position",
  "First Name",
  "Last Name",
  "Employee ID",
  "Shift Start Date",
  "Shift Start Time",
  "Shift End Time",
] as const;

function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (value instanceof Date) {
    // ExcelJS represents date-only cells as midnight UTC. Calendar dates must
    // not move backward when the home-base process runs west of UTC.
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value && value.result != null) return String(value.result).trim();
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((t) => t.text).join("").trim();
    }
  }
  return String(value).trim();
}

/** Zero-only number formats ("0000") are the one display format an ID cell can carry. */
const ZERO_PAD_FORMAT = /^0+$/;

/**
 * Employee ID exactly as the export displays it. A text cell stays as typed
 * (`0042` and `42` are two people). A numeric cell shows its zero-pad number
 * format when it has one; otherwise its plain digits. Never pads or strips.
 */
function employeeIdText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    const fmt = typeof cell.numFmt === "string" ? cell.numFmt.trim() : "";
    const digits = String(value);
    if (ZERO_PAD_FORMAT.test(fmt) && digits.length < fmt.length) {
      return "0".repeat(fmt.length - digits.length) + digits;
    }
    return digits;
  }
  return cellToString(value);
}

function isEmployeeIdHeader(h: string): boolean {
  return h.toLowerCase() === "employee id";
}

function normalizeHeader(h: string): string {
  return h.trim();
}

function rowsFromWorksheet(ws: ExcelJS.Worksheet): { headers: string[]; rows: RawRow[] } {
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = normalizeHeader(cellToString(cell.value));
  });
  while (headers.length && !headers[headers.length - 1]) headers.pop();

  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: RawRow = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const cell = row.getCell(i + 1);
      const v = isEmployeeIdHeader(h) ? employeeIdText(cell) : cellToString(cell.value);
      obj[h] = v;
      if (v) any = true;
    });
    if (any) rows.push(obj);
  });
  return { headers, rows };
}

function assertRequiredHeaders(headers: string[]) {
  const set = new Set(headers.map((h) => h.toLowerCase()));
  for (const req of REQUIRED_HEADERS) {
    if (!set.has(req.toLowerCase())) {
      throw new Error(`Missing required column: ${req}`);
    }
  }
}

function findHeader(row: RawRow, name: string): string {
  const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (row[key] ?? "") : "";
}

/** A row with a position and date but no Employee ID: an open shift (C1 step 6). */
type OpenShiftRow = { openShiftDate: string };

function parseRow(row: RawRow): ParsedShift | OpenShiftRow | null {
  const position = findHeader(row, "Position");
  const externalId = findHeader(row, "Employee ID");
  const firstName = findHeader(row, "First Name");
  const lastName = findHeader(row, "Last Name");
  const date = findHeader(row, "Shift Start Date");
  const startTime = findHeader(row, "Shift Start Time");
  const endTime = findHeader(row, "Shift End Time");

  if (!externalId && !position && !date) return null;
  // Open shifts are skipped and counted, never fatal. No Status filter (I2).
  if (!externalId) return isValidYmd(date) ? { openShiftDate: date } : null;
  if (!position || !date || !startTime || !endTime) {
    throw new Error(
      `Incomplete schedule row for employee=${externalId || "?"} position=${position || "?"}`,
    );
  }
  if (!isValidYmd(date)) {
    throw new Error(`Invalid Shift Start Date (expected YYYY-MM-DD): ${date}`);
  }

  const board = routePositionToBoard(position);
  return {
    externalId: String(externalId),
    firstName: firstName || "?",
    lastName: lastName || "?",
    date,
    startAt: chicagoDateTime(date, startTime),
    endAt: chicagoDateTime(date, endTime),
    sourcePosition: position,
    board,
    stationHint: positionStationHint(position),
  };
}

function summarize(shifts: ParsedShift[]): ParseResult["bucketCounts"] {
  const bucketCounts = { caja: 0, cocina: 0, other: 0 };
  for (const s of shifts) {
    bucketCounts[s.board] += 1;
  }
  return bucketCounts;
}

function detectStrippedPayColumns(headers: string[]): string[] {
  const lower = new Set(headers.map((h) => h.toLowerCase()));
  return PAY_COLUMNS.filter((c) => lower.has(c.toLowerCase()));
}

function parseFromWorksheet(ws: ExcelJS.Worksheet): ParseResult {
  const { headers, rows } = rowsFromWorksheet(ws);
  assertRequiredHeaders(headers);
  const strippedPayColumns = detectStrippedPayColumns(headers);
  const shifts: ParsedShift[] = [];
  const skippedOpenShifts: Record<string, number> = {};
  for (const row of rows) {
    const parsed = parseRow(row);
    if (!parsed) continue;
    if ("openShiftDate" in parsed) {
      skippedOpenShifts[parsed.openShiftDate] = (skippedOpenShifts[parsed.openShiftDate] ?? 0) + 1;
      continue;
    }
    shifts.push(parsed);
  }
  const dates = [...new Set(shifts.map((s) => s.date))].sort();
  return {
    shifts,
    bucketCounts: summarize(shifts),
    dates,
    strippedPayColumns,
    skippedOpenShifts,
  };
}

/**
 * Read CSV text into a worksheet. ExcelJS `csv.read` turns `0042` into the
 * number 42 before a cell exists, so the Employee ID column is read a second
 * time with no coercion and written back as text. Every other column keeps
 * ExcelJS's reading. Fails closed if the two reads disagree on shape.
 */
export async function readCsvWorksheet(
  text: string,
  workbook: ExcelJS.Workbook = new ExcelJS.Workbook(),
): Promise<ExcelJS.Worksheet> {
  const ws = await workbook.csv.read(Readable.from([text]));
  const raw = await new ExcelJS.Workbook().csv.read(Readable.from([text]), {
    map: (datum: string) => datum,
  });
  if (raw.rowCount !== ws.rowCount) {
    throw new Error("CSV rows could not be read consistently");
  }
  const header = raw.getRow(1);
  let idCol = 0;
  header.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (!idCol && isEmployeeIdHeader(normalizeHeader(String(cell.value ?? "")))) {
      idCol = colNumber;
    }
  });
  if (idCol) {
    for (let r = 2; r <= raw.rowCount; r++) {
      const text = String(raw.getRow(r).getCell(idCol).value ?? "").trim();
      ws.getRow(r).getCell(idCol).value = text === "" ? null : text;
    }
  }
  return ws;
}

/** Parse Schedules - Restaurant CSV (UTF-8). */
export async function parseSchedulesCsv(buf: Buffer): Promise<ParseResult> {
  const ws = await readCsvWorksheet(buf.toString("utf8"));
  ws.name = SCHEDULES_SHEET_NAME;
  return parseFromWorksheet(ws);
}

/**
 * Parse a When I Work Restaurant workbook (xlsx) or a Schedules CSV buffer.
 * Pay columns and staff email are never included on ParsedShift.
 */
export async function parseScheduleWorkbook(
  input: Buffer | ArrayBuffer | Uint8Array,
  opts?: { filename?: string },
): Promise<ParseResult> {
  const filename = (opts?.filename ?? "").toLowerCase();
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input);

  if (filename.endsWith(".csv")) {
    return parseSchedulesCsv(buf);
  }

  const workbook = new ExcelJS.Workbook();
  // exceljs typings accept Buffer via ArrayBuffer-like
  await workbook.xlsx.load(buf as unknown as ExcelJS.Buffer);

  const schedules =
    workbook.getWorksheet(SCHEDULES_SHEET_NAME) ??
    workbook.worksheets.find((w) => w.name.toLowerCase().includes("schedules"));

  if (!schedules) {
    if (workbook.worksheets.length === 1) {
      return parseFromWorksheet(workbook.worksheets[0]!);
    }
    throw new Error(`Missing sheet "${SCHEDULES_SHEET_NAME}"`);
  }

  // Hourly sheet is optional — ignore if present (SPEC §3)
  void workbook.getWorksheet(HOURLY_SHEET_NAME);

  return parseFromWorksheet(schedules);
}

export { PAY_COLUMNS };
