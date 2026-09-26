import { prisma } from "@/lib/db";
import { chicagoHourEnd, chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
import { isValidMoveReason, type MoveReason } from "@/lib/position-moves";
import { validateAssignment } from "@/lib/rules/assign";
import { isFutureHour } from "@/lib/rules/live-hour";
import { isHourInShift } from "@/lib/rules/shift-window";
import type { AbilityLevel, RuleViolation } from "@/lib/rules/types";

export type PaintEdit = {
  shiftId: string;
  hour: number;
  /** WIW may update a shift's hours in place without changing its id. */
  expectedShift: { startAt: string; endAt: string; employeeId: string; sourcePosition: string };
  /** The exact assignment the manager saw, including its station. */
  expected: { id: string; stationId: string } | null;
  stationId: string | null;
  reason?: string;
  note?: string | null;
};

export type PaintRequest = {
  board: "caja" | "cocina";
  date: string;
  edits: PaintEdit[];
};

type PaintFailure = {
  ok: false;
  status: 409 | 422;
  code: string;
  message: string;
  violations?: RuleViolation[];
};

type PaintResult = { ok: true; saved: number } | PaintFailure;

const conflict = (message: string): PaintFailure => ({
  ok: false,
  status: 409,
  code: "BOARD_CHANGED",
  message,
});

const invalid = (code: string, message: string, violations?: RuleViolation[]): PaintFailure => ({
  ok: false,
  status: 422,
  code,
  message,
  violations,
});

function key(a: string, hourStart: Date): string {
  return `${a}|${hourStart.getTime()}`;
}

function isWriteConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "P2002" || code === "P2034" || message.includes("SQLITE_BUSY");
}

/**
 * Apply one manager's painted day atomically. Every touched cell must still
 * match the assignment id and station visible when painting began. A WIW
 * re-import or another tablet's write therefore asks for a fresh review.
 */
export async function paintAssignments(
  request: PaintRequest,
  now: Date = new Date(),
): Promise<PaintResult> {
  if (request.edits.length === 0) return { ok: true, saved: 0 };
  try {
    return await prisma.$transaction(async (tx): Promise<PaintResult> => {
      const shifts = await tx.shift.findMany({
        where: { id: { in: request.edits.map((e) => e.shiftId) } },
      });
      const byShift = new Map(shifts.map((shift) => [shift.id, shift]));
      const stationIds = request.edits
        .map((e) => e.stationId)
        .filter((id): id is string => id != null);
      const stations = await tx.station.findMany({ where: { id: { in: stationIds } } });
      const byStation = new Map(stations.map((station) => [station.id, station]));
      const hourStarts = request.edits.map((e) => chicagoHourStart(request.date, e.hour));
      const allAtHours = await tx.assignment.findMany({
        where: { hourStart: { in: hourStarts } },
      });
      const abilities = await tx.employeeStationAbility.findMany({
        where: {
          employeeId: { in: shifts.map((shift) => shift.employeeId) },
          stationId: { in: stationIds },
        },
      });
      const abilityByKey = new Map(
        abilities.map((a) => [`${a.employeeId}|${a.stationId}`, a.level as AbilityLevel]),
      );
      const currentByPersonHour = new Map(
        allAtHours
          .filter((a) => a.employeeId != null)
          .map((a) => [key(a.employeeId!, a.hourStart), a]),
      );
      const seenPersonHours = new Set<string>();
      const changes: {
        edit: PaintEdit;
        shift: (typeof shifts)[number];
        hourStart: Date;
        current: (typeof allAtHours)[number] | null;
      }[] = [];

      for (const edit of request.edits) {
        const shift = byShift.get(edit.shiftId);
        if (!shift || shift.board !== request.board || shift.date !== request.date || shift.supersededAt) {
          return conflict("The imported shift changed. Refresh the board and review the painted hours.");
        }
        if (
          shift.startAt.toISOString() !== edit.expectedShift.startAt ||
          shift.endAt.toISOString() !== edit.expectedShift.endAt ||
          shift.employeeId !== edit.expectedShift.employeeId ||
          shift.sourcePosition !== edit.expectedShift.sourcePosition
        ) {
          return conflict("The shift hours changed. Refresh the board and review the painted hours.");
        }
        const hourStart = chicagoHourStart(request.date, edit.hour);
        const hourEnd = chicagoHourEnd(request.date, edit.hour);
        if (!isHourInShift(hourStart, shift.startAt, shift.endAt, hourEnd)) {
          return invalid("OUT_OF_SHIFT", "This hour does not overlap the person's shift.");
        }
        const personHour = key(shift.employeeId, hourStart);
        if (seenPersonHours.has(personHour)) {
          return invalid("DUPLICATE_CELL", "The same person and hour appears twice in this save.");
        }
        seenPersonHours.add(personHour);
        const current = currentByPersonHour.get(personHour) ?? null;
        if (
          current?.id !== (edit.expected?.id ?? undefined) ||
          current?.stationId !== (edit.expected?.stationId ?? undefined) ||
          (current != null && current.shiftId !== shift.id)
        ) {
          return conflict("An assignment changed since this screen loaded. Refresh and review before saving.");
        }
        if (edit.stationId === current?.stationId || (edit.stationId == null && current == null)) {
          continue;
        }
        if (current && !isFutureHour(hourStart, now) && !isValidMoveReason(edit.reason ?? "")) {
          return invalid("MOVE_REASON_REQUIRED", "A reason is required to change a current or past position.");
        }
        if (edit.stationId != null && byStation.get(edit.stationId)?.board !== request.board) {
          return invalid("STATION_BOARD_MISMATCH", "That position is not on this board.");
        }
        changes.push({ edit, shift, hourStart, current });
      }

      const touchedIds = new Set(changes.map((change) => change.current?.id).filter(Boolean));
      const remaining = allAtHours.filter((a) => !touchedIds.has(a.id));
      const stagedStationCount = new Map<string, number>();
      for (const change of changes) {
        const { edit, shift, hourStart } = change;
        if (!edit.stationId) continue;
        const station = byStation.get(edit.stationId)!;
        const stationHour = key(station.id, hourStart);
        const occupancy =
          remaining.filter((a) => a.stationId === station.id && a.hourStart.getTime() === hourStart.getTime()).length +
          (stagedStationCount.get(stationHour) ?? 0);
        const alreadyAssigned = remaining.some(
          (a) => a.employeeId === shift.employeeId && a.hourStart.getTime() === hourStart.getTime(),
        );
        const violations = validateAssignment({
          hourStart,
          hourEnd: chicagoHourEnd(request.date, edit.hour),
          shiftStart: shift.startAt,
          shiftEnd: shift.endAt,
          stationId: station.id,
          stationBoard: station.board,
          shiftBoard: shift.board,
          maxConcurrent: station.maxConcurrent,
          existingOccupancy: occupancy,
          abilityLevel: abilityByKey.get(`${shift.employeeId}|${station.id}`) ?? null,
          personAlreadyAssignedAtHour: alreadyAssigned,
          chicagoHour: chicagoHourOf(hourStart),
        });
        if (violations.length > 0) {
          return invalid(violations[0]!.code, violations[0]!.message, violations);
        }
        stagedStationCount.set(stationHour, (stagedStationCount.get(stationHour) ?? 0) + 1);
      }

      // Delete first, then recreate with the same ids. This also allows two
      // occupied positions to trade places without an intermediate unique hit.
      const deleteIds = changes.map((change) => change.current?.id).filter((id): id is string => id != null);
      if (deleteIds.length > 0) {
        await tx.assignment.deleteMany({ where: { id: { in: deleteIds } } });
      }
      for (const { edit, shift, hourStart, current } of changes) {
        if (current && !isFutureHour(hourStart, now)) {
          await tx.positionMoveLog.create({
            data: {
              date: request.date,
              hour: edit.hour,
              employeeId: shift.employeeId,
              fromStationId: current.stationId,
              toStationId: edit.stationId,
              assignmentId: current.id,
              reason: edit.reason as MoveReason,
              note: edit.note?.trim() || null,
            },
          });
        }
        if (edit.stationId) {
          await tx.assignment.create({
            data: {
              ...(current ? { id: current.id } : {}),
              shiftId: shift.id,
              employeeId: shift.employeeId,
              stationId: edit.stationId,
              hourStart,
              hourEnd: chicagoHourEnd(request.date, edit.hour),
            },
          });
        }
      }
      return { ok: true, saved: changes.length };
    });
  } catch (error) {
    if (isWriteConflict(error)) {
      return conflict("The board changed while saving. Refresh and review the painted hours.");
    }
    throw error;
  }
}
