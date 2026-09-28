import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeBoardChange, type BoardChangeActor } from "@/lib/board-change-log";
import { abilityColumn } from "@/lib/abilities/levels";
import {
  isColumnDefaultLevel,
  type ColumnDefaultLevel,
} from "@/lib/abilities/column-default";

type SettingRow = { key: string; hidden: boolean; defaultLevel: string };

type SettingDb = {
  abilityColumnSetting: {
    findMany: (args: {
      select: { key: true; hidden: true; defaultLevel: true };
    }) => Promise<SettingRow[]>;
  };
};

/**
 * Install seed. Rich's 1A: the five columns start hidden.
 * Pasteles and Relleno general are Nuevos no. The other three stay bien.
 */
export const ABILITY_COLUMN_INSTALL_SEED = [
  { key: "pdf_rngn", hidden: true, defaultLevel: "forbidden" },
  { key: "pdf_rlno", hidden: true, defaultLevel: "ok" },
  { key: "trastes", hidden: true, defaultLevel: "ok" },
  { key: "pdf_guia", hidden: true, defaultLevel: "ok" },
  { key: "pdf_pstl", hidden: true, defaultLevel: "forbidden" },
] as const satisfies readonly { key: string; hidden: boolean; defaultLevel: ColumnDefaultLevel }[];

export function defaultsByStation(
  rows: readonly { key: string; defaultLevel: string }[],
): Map<string, ColumnDefaultLevel> {
  const map = new Map<string, ColumnDefaultLevel>();
  for (const row of rows) {
    if (!isColumnDefaultLevel(row.defaultLevel)) continue;
    const column = abilityColumn(row.key);
    if (!column) continue;
    for (const stationId of column.stationIds) map.set(stationId, row.defaultLevel);
  }
  return map;
}

export async function loadColumnDefaults(
  db: SettingDb | Prisma.TransactionClient = prisma,
): Promise<Map<string, ColumnDefaultLevel>> {
  const rows = await db.abilityColumnSetting.findMany({
    select: { key: true, hidden: true, defaultLevel: true },
  });
  return defaultsByStation(rows);
}

export async function loadAbilityColumnSettings(): Promise<SettingRow[]> {
  return prisma.abilityColumnSetting.findMany({
    select: { key: true, hidden: true, defaultLevel: true },
    orderBy: { key: "asc" },
  });
}

export async function setAbilityColumnSetting(input: {
  key: string;
  hidden?: boolean;
  defaultLevel?: ColumnDefaultLevel;
  actor: BoardChangeActor;
}): Promise<{ ok: true; changed: boolean } | { ok: false; status: 400; error: string }> {
  if (!abilityColumn(input.key)) return { ok: false, status: 400, error: "Invalid column" };
  if (input.hidden == null && input.defaultLevel == null) {
    return { ok: false, status: 400, error: "Nothing to save" };
  }
  if (input.defaultLevel != null && !isColumnDefaultLevel(input.defaultLevel)) {
    return { ok: false, status: 400, error: "Invalid level" };
  }

  const existing = await prisma.abilityColumnSetting.findUnique({ where: { key: input.key } });
  const hidden = input.hidden ?? existing?.hidden ?? false;
  const defaultLevel = input.defaultLevel ?? (
    existing && isColumnDefaultLevel(existing.defaultLevel) ? existing.defaultLevel : "ok"
  );
  const hiddenSame = existing ? existing.hidden === hidden : input.hidden == null;
  const defaultSame = existing ? existing.defaultLevel === defaultLevel : input.defaultLevel == null;
  if (existing && hiddenSame && defaultSame) return { ok: true, changed: false };

  const columnHidden = input.hidden != null && input.hidden !== existing?.hidden
    ? (input.hidden ? "hidden" as const : "shown" as const)
    : undefined;
  const columnDefault = input.defaultLevel != null && input.defaultLevel !== existing?.defaultLevel
    ? input.defaultLevel
    : undefined;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.abilityColumnSetting.upsert({
      where: { key: input.key },
      create: { key: input.key, hidden, defaultLevel },
      update: { hidden, defaultLevel },
    });
    await writeBoardChange(tx, input.actor, {
      date: "undated",
      stationId: input.key,
      count: 1,
      columnHidden,
      columnDefault,
    });
  });
  return { ok: true, changed: true };
}

/**
 * Writes the five install rows and a log line for each change.
 * Does not read or write EmployeeStationAbility.
 */
export async function seedAbilityColumnSettings(actor: BoardChangeActor): Promise<{
  written: number;
  unchanged: number;
}> {
  let written = 0;
  let unchanged = 0;
  for (const row of ABILITY_COLUMN_INSTALL_SEED) {
    const result = await setAbilityColumnSetting({ ...row, actor });
    if (!result.ok) throw new Error(result.error);
    if (result.changed) written += 1;
    else unchanged += 1;
  }
  return { written, unchanged };
}
