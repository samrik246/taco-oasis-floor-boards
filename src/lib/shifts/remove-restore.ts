import { prisma } from "@/lib/db";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { validateAssignment } from "@/lib/rules/assign";
import { chicagoHourOf } from "@/lib/hour-grid";
import { seatNumberForWrite } from "@/lib/assignments/seat-number";
import { dropBreakForShift } from "@/lib/breaks/import-drop";

type Manager = { id: string; name: string };
type Source = { startAt: string; endAt: string; employeeId: string; sourcePosition: string };
type Cell = { id: string; stationId: string; hourStart: string; hourEnd: string };

export class ShiftRemovalError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 409) {
    super(message);
  }
}

function conflict(code: string, message: string): never {
  throw new ShiftRemovalError(code, message);
}

function sourceMatches(shift: { startAt: Date; endAt: Date; employeeId: string; sourcePosition: string },
                       expected: Source) {
  return shift.startAt.toISOString() === expected.startAt &&
    shift.endAt.toISOString() === expected.endAt &&
    shift.employeeId === expected.employeeId && shift.sourcePosition === expected.sourcePosition;
}

function snapshot(shift: { id: string; date: string; board: string; sourcePosition: string;
  startAt: Date; endAt: Date; employee: { externalId: string } }) {
  return { shiftId: shift.id, externalId: shift.employee.externalId,
    date: shift.date, board: shift.board, sourcePosition: shift.sourcePosition,
    startAt: shift.startAt.toISOString(), endAt: shift.endAt.toISOString() };
}

function cellsFromJson(value: string): Cell[] {
  const raw: unknown = JSON.parse(value);
  if (!Array.isArray(raw) || !raw.every((c) => c && typeof c === "object" &&
    typeof c.id === "string" && typeof c.stationId === "string" &&
    typeof c.hourStart === "string" && typeof c.hourEnd === "string")) {
    conflict("HISTORY_INVALID", "Saved positions are invalid; restore without positions or request review.");
  }
  return raw as Cell[];
}

/** Remove exactly one currently imported occurrence in one transaction. */
export async function removeShift(input: {
  shiftId: string; board: "caja" | "cocina"; date: string;
  expected: Source; expectedRevision: number; reason: string; manager: Manager; now?: Date;
}) {
  const reason = input.reason.trim();
  if (!reason) throw new ShiftRemovalError("REASON_REQUIRED", "A reason is required.", 400);
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const shift = await tx.shift.findUnique({
      where: { id: input.shiftId },
      include: { employee: { select: { externalId: true } }, assignments: true, removalOverride: true },
    });
    if (!shift || shift.board !== input.board || shift.date !== input.date || shift.supersededAt) {
      throw new ShiftRemovalError("SHIFT_NOT_CURRENT", "This imported shift is no longer current.", 404);
    }
    if (!sourceMatches(shift, input.expected) || shift.boardRemoved) {
      conflict("SHIFT_CHANGED", "The shift changed. Refresh before removing it.");
    }
    const prior = shift.removalOverride;
    if ((prior?.revision ?? 0) !== input.expectedRevision || prior?.state === "removed") {
      conflict("REVISION_CHANGED", "This removal changed. Refresh before trying again.");
    }
    const future = shift.assignments.filter((cell) => cell.hourStart.getTime() > now.getTime());
    const cells: Cell[] = future.map((cell) => ({ id: cell.id, stationId: cell.stationId,
      hourStart: cell.hourStart.toISOString(), hourEnd: cell.hourEnd.toISOString() }));
    if (future.length) {
      const deleted = await tx.assignment.deleteMany({ where: { id: { in: future.map((c) => c.id) } } });
      if (deleted.count !== future.length) conflict("ASSIGNMENT_CHANGED", "A position changed. Refresh before removing.");
    }
    const hidden = await tx.shift.updateMany({ where: { id: shift.id, boardRemoved: false,
      supersededAt: null, startAt: shift.startAt, endAt: shift.endAt }, data: { boardRemoved: true } });
    if (hidden.count !== 1) conflict("SHIFT_CHANGED", "The shift changed. Refresh before removing.");
    await dropBreakForShift(tx, shift.id);
    const data = { shiftId: shift.id, externalId: shift.employee.externalId,
      date: shift.date, board: shift.board, sourcePosition: shift.sourcePosition,
      startAt: shift.startAt, endAt: shift.endAt, state: "removed", cellsJson: JSON.stringify(cells) };
    const override = prior
      ? await tx.shiftRemoval.update({ where: { id: prior.id }, data: { ...data, revision: { increment: 1 } } })
      : await tx.shiftRemoval.create({ data });
    await tx.shiftRemovalEvent.create({ data: { overrideId: override.id, action: "remove",
      revision: override.revision,
      managerId: input.manager.id, managerName: input.manager.name, reason,
      sourceJson: JSON.stringify(snapshot(shift)), cellsJson: JSON.stringify(cells) } });
    return { id: override.id, revision: override.revision, removedCells: cells.length };
  });
}

/** Restore a removed occurrence without overwriting another manager's cells. */
export async function restoreShift(input: {
  id: string; expectedRevision: number; expected: Source;
  positions: "replay" | "none"; reason: string; manager: Manager; now?: Date;
}) {
  const reason = input.reason.trim();
  if (!reason) throw new ShiftRemovalError("REASON_REQUIRED", "A reason is required.", 400);
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const override = await tx.shiftRemoval.findUnique({ where: { id: input.id } });
    if (!override) throw new ShiftRemovalError("NOT_FOUND", "Removed shift not found.", 404);
    if (override.state !== "removed" || override.revision !== input.expectedRevision) {
      conflict("REVISION_CHANGED", "This removal changed. Refresh before restoring.");
    }
    if (!override.shiftId) conflict("SOURCE_MISSING", "The source shift is missing. Import a current schedule first.");
    const shift = await tx.shift.findUnique({ where: { id: override.shiftId! },
      include: { employee: { select: { externalId: true } } } });
    if (!shift || shift.supersededAt || !shift.boardRemoved ||
        shift.employee.externalId !== override.externalId ||
        shift.date !== override.date || shift.board !== override.board ||
        shift.sourcePosition !== override.sourcePosition ||
        !sourceMatches(shift, input.expected) ||
        shift.startAt.getTime() !== override.startAt.getTime() ||
        shift.endAt.getTime() !== override.endAt.getTime()) {
      conflict("SOURCE_CHANGED", "The current source shift changed. Refresh before restoring.");
    }
    const saved = cellsFromJson(override.cellsJson);
    const future = input.positions === "replay"
      ? saved.filter((cell) => new Date(cell.hourStart).getTime() > now.getTime()) : [];
    const columnDefaults = await loadColumnDefaults(tx);
    for (const cell of future) {
      const hourStart = new Date(cell.hourStart);
      const hourEnd = new Date(cell.hourEnd);
      const station = await tx.station.findUnique({ where: { id: cell.stationId } });
      if (!station) conflict("STATION_MISSING", "A saved position no longer exists. Restore without positions.");
      const ability = await tx.employeeStationAbility.findUnique({
        where: { employeeId_stationId: { employeeId: shift.employeeId, stationId: cell.stationId } },
      });
      const occupancy = await tx.assignment.count({ where: { stationId: cell.stationId, hourStart } });
      const personBusy = await tx.assignment.count({ where: { employeeId: shift.employeeId, hourStart } });
      const violations = validateAssignment({ hourStart, hourEnd,
        shiftStart: shift.startAt, shiftEnd: shift.endAt, stationId: station!.id,
        stationBoard: station!.board, shiftBoard: shift.board,
        maxConcurrent: station!.maxConcurrent, existingOccupancy: occupancy,
        abilityLevel: levelWhenUnset(ability?.level, columnDefaults.get(cell.stationId)),
        personAlreadyAssignedAtHour: personBusy > 0, chicagoHour: chicagoHourOf(hourStart) });
      if (violations.length) conflict("POSITION_CONFLICT",
        `A saved position no longer fits (${violations.map((v) => v.code).join(", ")}). Restore without positions or repaint.`);
    }
    for (const cell of future) {
      const hourStart = new Date(cell.hourStart);
      const seatNumber = await seatNumberForWrite(tx, {
        stationId: cell.stationId,
        hourStart,
        employeeId: shift.employeeId,
      });
      await tx.assignment.create({ data: { shiftId: shift.id, employeeId: shift.employeeId,
        stationId: cell.stationId, hourStart, hourEnd: new Date(cell.hourEnd), seatNumber } });
    }
    const changed = await tx.shift.updateMany({ where: { id: shift.id, boardRemoved: true,
      supersededAt: null, startAt: shift.startAt, endAt: shift.endAt }, data: { boardRemoved: false } });
    if (changed.count !== 1) conflict("SHIFT_CHANGED", "The shift changed during restore.");
    const updated = await tx.shiftRemoval.update({ where: { id: override.id },
      data: { state: "restored", revision: { increment: 1 } } });
    await tx.shiftRemovalEvent.create({ data: { overrideId: override.id, action: "restore",
      revision: updated.revision,
      managerId: input.manager.id, managerName: input.manager.name, reason,
      sourceJson: JSON.stringify(snapshot(shift)),
      cellsJson: JSON.stringify({ cells: future, positions: input.positions }) } });
    return { id: updated.id, revision: updated.revision, restoredCells: future.length };
  });
}

/** A manager may retire a missing-source tombstone instead of guessing its new identity. */
export async function resolveMissingRemoval(input: {
  id: string; expectedRevision: number; reason: string; manager: Manager;
}) {
  const reason = input.reason.trim();
  if (!reason) throw new ShiftRemovalError("REASON_REQUIRED", "A reason is required.", 400);
  return prisma.$transaction(async (tx) => {
    const override = await tx.shiftRemoval.findUnique({ where: { id: input.id } });
    if (!override) throw new ShiftRemovalError("NOT_FOUND", "Removed shift not found.", 404);
    if (override.state !== "removed" || override.shiftId !== null ||
        override.revision !== input.expectedRevision) {
      conflict("REVISION_CHANGED", "This missing-source removal changed. Refresh before resolving it.");
    }
    const updated = await tx.shiftRemoval.update({ where: { id: override.id },
      data: { state: "resolved", revision: { increment: 1 } } });
    await tx.shiftRemovalEvent.create({ data: { overrideId: updated.id, action: "resolve",
      revision: updated.revision, managerId: input.manager.id,
      managerName: input.manager.name, reason,
      sourceJson: JSON.stringify({ shiftId: null, externalId: updated.externalId,
        date: updated.date, board: updated.board, sourcePosition: updated.sourcePosition,
        startAt: updated.startAt.toISOString(), endAt: updated.endAt.toISOString() }),
      cellsJson: updated.cellsJson } });
    return { id: updated.id, revision: updated.revision, state: updated.state };
  });
}

export async function listShiftRemovals(board: "caja" | "cocina", date: string) {
  return prisma.shiftRemoval.findMany({ where: { board, date },
    include: { shift: true, events: { orderBy: { revision: "asc" } } },
    orderBy: { createdAt: "asc" } });
}
