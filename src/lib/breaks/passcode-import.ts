export const PASSCODE_BACKUP_DIR_NAME = "staff-passcode-backups";

export type PasscodeCounts = {
  rows: number;
  matched: number;
  unmatched: number;
  malformed: number;
  duplicateIds: number;
};

export type PasscodeWrite = {
  externalId: string;
  code: string;
};

const EMPTY: PasscodeCounts = {
  rows: 0,
  matched: 0,
  unmatched: 0,
  malformed: 0,
  duplicateIds: 0,
};

/** Four ASCII digits after trim. Column numbers are 1-based. The file has no header row. */
export function planStaffPasscodeCsv(
  text: string,
  idColumn: number,
  codeColumn: number,
  knownExternalIds: ReadonlySet<string>,
): { counts: PasscodeCounts; writes: PasscodeWrite[] } {
  const counts = { ...EMPTY };
  if (!Number.isInteger(idColumn) || !Number.isInteger(codeColumn) || idColumn < 1 || codeColumn < 1) {
    return { counts, writes: [] };
  }
  const pending: PasscodeWrite[] = [];
  const seen = new Map<string, number>();
  const width = Math.max(idColumn, codeColumn);
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    counts.rows += 1;
    const cells = line.split(",");
    const externalId = (cells[idColumn - 1] ?? "").trim();
    const code = (cells[codeColumn - 1] ?? "").trim();
    if (cells.length < width || externalId === "" || !/^[0-9]{4}$/.test(code)) {
      counts.malformed += 1;
      continue;
    }
    seen.set(externalId, (seen.get(externalId) ?? 0) + 1);
    if (knownExternalIds.has(externalId)) counts.matched += 1;
    else counts.unmatched += 1;
    pending.push({ externalId, code });
  }
  const duplicated = new Set<string>();
  for (const [externalId, count] of seen) {
    if (count > 1) duplicated.add(externalId);
  }
  counts.duplicateIds = duplicated.size;
  const writes = pending.filter((row) => knownExternalIds.has(row.externalId) && !duplicated.has(row.externalId));
  return { counts, writes };
}

export function passcodeApplyAllowed(counts: PasscodeCounts): boolean {
  return counts.malformed === 0 && counts.duplicateIds === 0 && counts.matched > 0;
}
