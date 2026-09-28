/**
 * Host import for staff passcodes. Default is a dry run.
 * Prints one JSON count line and nothing else. Never prints a code, a hash, or a name.
 *
 * Usage: tsx scripts/import-staff-passcodes.ts --file <path> --id-column N --code-column N [--apply]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import {
  hashStaffPasscode,
  newPasscodeSalt,
  staffPasscodePepper,
} from "../src/lib/breaks/passcode";
import {
  PASSCODE_BACKUP_DIR_NAME,
  passcodeApplyAllowed,
  planStaffPasscodeCsv,
  type PasscodeCounts,
} from "../src/lib/breaks/passcode-import";

const EMPTY: PasscodeCounts = {
  rows: 0,
  matched: 0,
  unmatched: 0,
  malformed: 0,
  duplicateIds: 0,
};

let printed = false;

function printCounts(counts: PasscodeCounts): void {
  if (printed) return;
  printed = true;
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function column(name: string): number | null {
  const raw = flag(name);
  if (raw == null || !/^[1-9][0-9]*$/.test(raw)) return null;
  return Number(raw);
}

function sqliteFile(url: string | undefined): string | null {
  if (!url?.startsWith("file:")) return null;
  const rest = url.slice("file:".length);
  if (rest.startsWith("///")) return rest.slice(2);
  return rest;
}

function backupDatabase(dbFile: string): boolean {
  const dir = path.join(path.dirname(dbFile), PASSCODE_BACKUP_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dest = path.join(dir, `${stamp}.db`);
  try {
    execFileSync("sqlite3", [dbFile, `.backup ${dest}`], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return false;
  }
  return fs.existsSync(dest) && fs.statSync(dest).size > 0;
}

async function main(): Promise<void> {
  let counts = { ...EMPTY };
  try {
    const file = flag("file");
    const idColumn = column("id-column");
    const codeColumn = column("code-column");
    const apply = process.argv.includes("--apply");
    if (!file || idColumn == null || codeColumn == null) {
      printCounts(counts);
      process.exitCode = 1;
      return;
    }
    const pepper = staffPasscodePepper();
    const text = fs.readFileSync(file, "utf8");
    const employees = await prisma.employee.findMany({ select: { id: true, externalId: true } });
    const byExternal = new Map(employees.map((employee) => [employee.externalId, employee.id]));
    const plan = planStaffPasscodeCsv(text, idColumn, codeColumn, new Set(byExternal.keys()));
    counts = plan.counts;
    if (!apply) {
      printCounts(counts);
      return;
    }
    if (!passcodeApplyAllowed(counts)) {
      printCounts(counts);
      process.exitCode = 1;
      return;
    }
    const dbFile = sqliteFile(process.env.DATABASE_URL);
    if (!dbFile || !backupDatabase(dbFile)) {
      printCounts(counts);
      process.exitCode = 1;
      return;
    }
    await prisma.$transaction(async (tx) => {
      for (const row of plan.writes) {
        const employeeId = byExternal.get(row.externalId);
        if (!employeeId) continue;
        const salt = newPasscodeSalt();
        const hash = await hashStaffPasscode(row.code, salt, pepper);
        await tx.staffPasscode.upsert({
          where: { employeeId },
          create: { employeeId, hash: hash.toString("hex"), salt: salt.toString("hex") },
          update: { hash: hash.toString("hex"), salt: salt.toString("hex") },
        });
      }
    });
    printCounts(counts);
  } catch {
    printCounts(counts);
    process.exitCode = 1;
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
