import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeBoardChange, type BoardChangeActor } from "@/lib/board-change-log";
import { isAbilityLevel } from "@/lib/employees/service";
import type { AbilityLevel } from "@/lib/rules/types";
import { abilityColumn, cajaAbilityColumns, cellLevel, cocinaAbilityColumns } from "@/lib/abilities/levels";
import { defaultsByStation, loadAbilityColumnSettings } from "@/lib/abilities/column-settings";

const CARNE_COLUMN = "pdf_crne";

/** A stored Carne row wins. With none stored, the grid hides the column at bien. */
function withUnstoredCarneDefault(
  rows: readonly { key: string; hidden: boolean; defaultLevel: string }[],
) {
  if (rows.some((row) => row.key === CARNE_COLUMN)) return rows;
  return [...rows, { key: CARNE_COLUMN, hidden: true, defaultLevel: "ok" }];
}

export async function loadAbilityGrid(board: "caja" | "cocina") {
  const columns = board === "caja" ? cajaAbilityColumns() : cocinaAbilityColumns();
  const settings = await loadAbilityColumnSettings();
  const defaults = defaultsByStation(settings);
  const shifts = await prisma.shift.findMany({
    where: { board, boardRemoved: false, supersededAt: null },
    select: {
      employee: {
        select: {
          id: true,
          externalId: true,
          firstName: true,
          lastName: true,
          abilities: { select: { stationId: true, level: true } },
        },
      },
    },
  });
  const byId = new Map<string, (typeof shifts)[number]["employee"]>();
  for (const shift of shifts) byId.set(shift.employee.id, shift.employee);
  const people = [...byId.values()]
    .sort(
      (a, b) =>
        a.firstName.localeCompare(b.firstName) ||
        a.lastName.localeCompare(b.lastName) ||
        a.id.localeCompare(b.id),
    )
    .map((employee) => ({
      id: employee.id,
      externalId: employee.externalId,
      firstName: employee.firstName,
      lastName: employee.lastName,
      cells: Object.fromEntries(
        columns.map((column) => [
          column.key,
          cellLevel(column.stationIds, employee.abilities, defaults),
        ]),
      ),
    }));
  const settingRows = board === "cocina" ? withUnstoredCarneDefault(settings) : settings;
  return {
    board,
    columns: columns.map(({ key, label, kind, color }) => ({ key, label, kind, color })),
    settings: settingRows.map((row) => ({
      key: row.key,
      hidden: row.hidden,
      defaultLevel: row.defaultLevel,
    })),
    people,
  };
}

export async function loadCocinaAbilityGrid() {
  return loadAbilityGrid("cocina");
}

export async function setAbilityColumn(input: {
  employeeId: string;
  column: string;
  level: string;
  actor: BoardChangeActor;
}): Promise<
  | { ok: true; written: number }
  | { ok: false; status: 400 | 404; error: string }
> {
  const column = abilityColumn(input.column);
  if (!column) return { ok: false, status: 400, error: "Invalid column" };
  if (!isAbilityLevel(input.level)) return { ok: false, status: 400, error: "Invalid level" };
  const level: AbilityLevel = input.level;
  const employee = await prisma.employee.findUnique({
    where: { id: input.employeeId },
    select: { id: true },
  });
  if (!employee) return { ok: false, status: 404, error: "Not found" };
  const stations = await prisma.station.findMany({
    where: { id: { in: [...column.stationIds] } },
    select: { id: true },
  });
  if (stations.length !== column.stationIds.length) {
    return { ok: false, status: 400, error: "Unknown station" };
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const stationId of column.stationIds) {
      await tx.employeeStationAbility.upsert({
        where: { employeeId_stationId: { employeeId: input.employeeId, stationId } },
        create: { employeeId: input.employeeId, stationId, level },
        update: { level },
      });
    }
    await writeBoardChange(tx, input.actor, {
      date: "undated",
      stationId: column.key,
      count: column.stationIds.length,
    });
  });
  return { ok: true, written: column.stationIds.length };
}
