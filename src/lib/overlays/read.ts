import type { Prisma, PrismaClient } from "@prisma/client";
import { chicagoHourOf } from "@/lib/hour-grid";
import { SLICE_COUNT, sliceStart, type SliceOverlay } from "@/lib/slices/day-slices";

export type OverlayKind = "switch" | "remove" | "add";
export type OverlayEndReason = "cancel" | "import";

export type OverlayRecord = {
  id: string;
  date: string;
  board: "caja" | "cocina";
  kind: OverlayKind;
  employeeId: string;
  partnerEmployeeId: string | null;
  stationId: string;
  fromStationId: string | null;
  startAt: Date;
  endAt: Date;
  managerId: string;
  managerName: string;
  cancelledAt: Date | null;
  endReason: OverlayEndReason | null;
  createdAt: Date;
};

export type OverlayDto = {
  id: string;
  kind: OverlayKind;
  employeeId: string;
  partnerEmployeeId: string | null;
  stationId: string;
  fromStationId: string | null;
  startAt: string;
  endAt: string;
  managerId: string;
  managerName: string;
  cancelledAt: string | null;
  endReason: OverlayEndReason | null;
};

type Db = PrismaClient | Prisma.TransactionClient;

function asKind(value: string): OverlayKind | null {
  if (value === "switch" || value === "remove" || value === "add") return value;
  return null;
}

function asBoard(value: string): "caja" | "cocina" | null {
  if (value === "caja" || value === "cocina") return value;
  return null;
}

function asEnd(value: string | null): OverlayEndReason | null {
  if (value === "cancel" || value === "import") return value;
  return null;
}

/** Newest first, so a later row is the one the slice engine finds. */
export async function loadOverlayRecords(
  db: Db,
  board: string,
  date: string,
): Promise<OverlayRecord[]> {
  const rows = await db.boardOverlay.findMany({
    where: { board, date },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.flatMap((row) => {
    const kind = asKind(row.kind);
    const rowBoard = asBoard(row.board);
    if (!kind || !rowBoard) return [];
    return [{
      id: row.id,
      date: row.date,
      board: rowBoard,
      kind,
      employeeId: row.employeeId,
      partnerEmployeeId: row.partnerEmployeeId,
      stationId: row.stationId,
      fromStationId: row.fromStationId,
      startAt: row.startAt,
      endAt: row.endAt,
      managerId: row.managerId,
      managerName: row.managerName,
      cancelledAt: row.cancelledAt,
      endReason: asEnd(row.endReason),
      createdAt: row.createdAt,
    }];
  });
}

export function toSliceOverlay(row: OverlayRecord): SliceOverlay {
  return {
    id: row.id,
    kind: row.kind,
    employeeId: row.employeeId,
    partnerEmployeeId: row.partnerEmployeeId,
    stationId: row.stationId,
    fromStationId: row.fromStationId,
    startAt: row.startAt,
    endAt: row.endAt,
    cancelledAt: row.cancelledAt,
  };
}

/** The screen drops a cancelled row and a window that has already ended. The list keeps both. */
export function screenOverlays(rows: readonly OverlayRecord[], now: Date): SliceOverlay[] {
  return rows
    .filter((row) => row.cancelledAt == null && row.endAt.getTime() > now.getTime())
    .map(toSliceOverlay);
}

export function overlayDto(row: OverlayRecord): OverlayDto {
  return {
    id: row.id,
    kind: row.kind,
    employeeId: row.employeeId,
    partnerEmployeeId: row.partnerEmployeeId,
    stationId: row.stationId,
    fromStationId: row.fromStationId,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    managerId: row.managerId,
    managerName: row.managerName,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    endReason: row.endReason,
  };
}

/** Same screen filter for the day payload, whose instants are ISO strings. */
export function screenOverlaysFromDto(
  rows: readonly OverlayDto[],
  now: Date,
): SliceOverlay[] {
  return rows.flatMap((row) => {
    const endAt = new Date(row.endAt);
    if (row.cancelledAt != null || endAt.getTime() <= now.getTime()) return [];
    return [{
      id: row.id,
      kind: row.kind,
      employeeId: row.employeeId,
      partnerEmployeeId: row.partnerEmployeeId,
      stationId: row.stationId,
      fromStationId: row.fromStationId,
      startAt: new Date(row.startAt),
      endAt,
      cancelledAt: null,
    }];
  });
}

/** Hours a live remove opens for this person. The amber mark uses this set. */
export function removedHours(
  rows: readonly OverlayDto[],
  employeeId: string,
  date: string,
  now: Date,
): Set<number> {
  const hours = new Set<number>();
  for (const row of screenOverlaysFromDto(rows, now)) {
    if (row.kind !== "remove" || row.employeeId !== employeeId) continue;
    for (let index = 0; index < SLICE_COUNT; index += 1) {
      const start = sliceStart(date, index);
      const end = sliceStart(date, index + 1);
      if (start.getTime() >= row.startAt.getTime() && end.getTime() <= row.endAt.getTime()) {
        hours.add(chicagoHourOf(start));
      }
    }
  }
  return hours;
}
