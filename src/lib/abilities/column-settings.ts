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

/** Install rewrite. Saved bien becomes no on these two stations only. */
export const ABILITY_OK_RESET_STATIONS = ["pdf_pstl", "pdf_rngn"] as const;

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
 * One transaction, after the caller's backup: the five column settings,
 * then saved bien becomes no on Pasteles and Relleno general only.
 * Training, preferred, forbidden, and every other station stay.
 * A rewrite writes one count line and no names. Zero rows is a no-op log.
 */
export async function seedAbilityColumnSettings(actor: BoardChangeActor): Promise<{
  written: number;
  unchanged: number;
  okToForbidden: { pdf_pstl: number; pdf_rngn: number };
}> {
  return prisma.$transaction(async (tx) => {
    let written = 0;
    let unchanged = 0;
    for (const row of ABILITY_COLUMN_INSTALL_SEED) {
      const existing = await tx.abilityColumnSetting.findUnique({ where: { key: row.key } });
      if (existing && existing.hidden === row.hidden && existing.defaultLevel === row.defaultLevel) {
        unchanged += 1;
        continue;
      }
      await tx.abilityColumnSetting.upsert({
        where: { key: row.key },
        create: { key: row.key, hidden: row.hidden, defaultLevel: row.defaultLevel },
        update: { hidden: row.hidden, defaultLevel: row.defaultLevel },
      });
      const columnHidden = !existing || existing.hidden !== row.hidden
        ? (row.hidden ? "hidden" as const : "shown" as const)
        : undefined;
      const columnDefault = !existing || existing.defaultLevel !== row.defaultLevel
        ? row.defaultLevel
        : undefined;
      await writeBoardChange(tx, actor, {
        date: "undated",
        stationId: row.key,
        count: 1,
        columnHidden,
        columnDefault,
      });
      written += 1;
    }

    const okToForbidden = { pdf_pstl: 0, pdf_rngn: 0 };
    for (const stationId of ABILITY_OK_RESET_STATIONS) {
      const result = await tx.employeeStationAbility.updateMany({
        where: { stationId, level: "ok" },
        data: { level: "forbidden" },
      });
      okToForbidden[stationId] = result.count;
    }
    if (okToForbidden.pdf_pstl + okToForbidden.pdf_rngn > 0) {
      await writeBoardChange(tx, actor, {
        date: "undated",
        count: okToForbidden.pdf_pstl + okToForbidden.pdf_rngn,
        abilityOkReset: ABILITY_OK_RESET_STATIONS.map((stationId) => ({
          stationId,
          count: okToForbidden[stationId],
        })),
      });
    }
    return { written, unchanged, okToForbidden };
  });
}
