import { prisma } from "@/lib/db";
import { chicagoHourEnd, chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
import { isValidMoveReason, type MoveReason } from "@/lib/position-moves";
import { validateAssignment } from "@/lib/rules/assign";
import { isFutureHour } from "@/lib/rules/live-hour";
import { isHourInShift } from "@/lib/rules/shift-window";
import type { AbilityLevel, RuleViolation } from "@/lib/rules/types";
import { PAINT_FAMILIES, type PaintFamily } from "@/lib/assignments/paint-families";
import { planPaintSeatNumbers } from "@/lib/assignments/seat-number";
import { writeBoardChange, type BoardChangeActor } from "@/lib/board-change-log";

export type PaintEdit = {
  shiftId: string;
  hour: number;
  /** WIW may update a shift's hours in place without changing its id. */
  expectedShift: { startAt: string; endAt: string; employeeId: string; sourcePosition: string };
  /** The exact assignment the manager saw, including its station. */
  expected: { id: string; stationId: string } | null;
  stationId: string | null;
  /** One manager choice; the saved row always uses a concrete numbered station. */
  family?: PaintFamily;
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
  actor?: BoardChangeActor,
): Promise<PaintResult> {
  if (request.edits.length === 0) return { ok: true, saved: 0 };
  try {
    return await prisma.$transaction(async (tx): Promise<PaintResult> => {
      const shifts = await tx.shift.findMany({
        where: { id: { in: request.edits.map((e) => e.shiftId) } },
      });
      const byShift = new Map(shifts.map((shift) => [shift.id, shift]));
      const stationIds = [...new Set(request.edits.flatMap((edit) =>
        edit.family ? [...PAINT_FAMILIES[edit.family]] : edit.stationId ? [edit.stationId] : [],
      ))];
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
      const familyAnchors: { shiftId: string; hour: number; family: PaintFamily; stationId: string }[] = [];
      const changes: {
        edit: PaintEdit;
        shift: (typeof shifts)[number];
        hourStart: Date;
        current: (typeof allAtHours)[number] | null;
        stationId: string | null;
      }[] = [];

      for (const edit of request.edits) {
        if (edit.family && edit.stationId !== null) {
          return invalid("INVALID_TARGET", "Choose either a numbered position or a position family.");
        }
        const shift = byShift.get(edit.shiftId);
        if (!shift || shift.board !== request.board || shift.date !== request.date || shift.supersededAt || shift.boardRemoved) {
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
        if (edit.family) {
          const familyStations = PAINT_FAMILIES[edit.family];
          if (familyStations.some((id) => byStation.get(id)?.board !== request.board)) {
            return conflict("This position family changed. Refresh the board and review the painted hours.");
          }
          if (current && (familyStations as readonly string[]).includes(current.stationId)) {
            if (abilityByKey.get(`${shift.employeeId}|${current.stationId}`) !== "forbidden") {
              familyAnchors.push({ shiftId: shift.id, hour: edit.hour, family: edit.family, stationId: current.stationId });
              continue;
            }
          }
        } else if (edit.stationId === current?.stationId || (edit.stationId == null && current == null)) {
          continue;
        }
        if (current && !isFutureHour(hourStart, now) && !isValidMoveReason(edit.reason ?? "")) {
          return invalid("MOVE_REASON_REQUIRED", "A reason is required to change a current or past position.");
        }
        if (edit.stationId != null && byStation.get(edit.stationId)?.board !== request.board) {
          return invalid("STATION_BOARD_MISMATCH", "That position is not on this board.");
        }
        changes.push({ edit, shift, hourStart, current, stationId: edit.stationId });
      }

      const touchedIds = new Set(changes.map((change) => change.current?.id).filter(Boolean));
      const remaining = allAtHours.filter((a) => !touchedIds.has(a.id));
      const stagedStationCount = new Map<string, number>();
      const occupancyAt = (id: string, hourStart: Date) =>
        remaining.filter((a) => a.stationId === id && a.hourStart.getTime() === hourStart.getTime()).length +
        (stagedStationCount.get(key(id, hourStart)) ?? 0);
      const reserve = (id: string, hourStart: Date) => {
        const stationHour = key(id, hourStart);
        stagedStationCount.set(stationHour, (stagedStationCount.get(stationHour) ?? 0) + 1);
      };
      const validateTarget = (change: (typeof changes)[number], id: string) => {
        const { edit, shift, hourStart } = change;
        const station = byStation.get(id)!;
        const alreadyAssigned = remaining.some(
          (a) => a.employeeId === shift.employeeId && a.hourStart.getTime() === hourStart.getTime(),
        );
        return validateAssignment({
          hourStart,
          hourEnd: chicagoHourEnd(request.date, edit.hour),
          shiftStart: shift.startAt,
          shiftEnd: shift.endAt,
          stationId: station.id,
          stationBoard: station.board,
          shiftBoard: shift.board,
          maxConcurrent: station.maxConcurrent,
          existingOccupancy: occupancyAt(station.id, hourStart),
          abilityLevel: abilityByKey.get(`${shift.employeeId}|${station.id}`) ?? null,
          personAlreadyAssignedAtHour: alreadyAssigned,
          chicagoHour: chicagoHourOf(hourStart),
        });
      };

      // Concrete targets reserve first, independent of request order. A family
      // can never take a slot that another cell in this save explicitly names.
      for (const change of changes.filter((item) => !item.edit.family && item.stationId)) {
        const violations = validateTarget(change, change.stationId!);
        if (violations.length > 0) {
          return invalid(violations[0]!.code, violations[0]!.message, violations);
        }
        reserve(change.stationId!, change.hourStart);
      }

      // Resolve each contiguous painted range against the same transaction
      // snapshot. Prefer one available number throughout; otherwise use the
      // first free number at each hour. Stable ordering resolves ties.
      const grouped = changes.filter((item) => item.edit.family).sort((a, b) =>
        a.shift.id.localeCompare(b.shift.id) || a.edit.hour - b.edit.hour,
      );
      for (let index = 0; index < grouped.length;) {
        const first = grouped[index]!;
        const range = [first];
        index += 1;
        while (index < grouped.length && grouped[index]!.shift.id === first.shift.id &&
          grouped[index]!.edit.family === first.edit.family &&
          grouped[index]!.edit.hour === range.at(-1)!.edit.hour + 1) {
          range.push(grouped[index]!);
          index += 1;
        }
        const ids = PAINT_FAMILIES[first.edit.family!];
        const available = (change: (typeof changes)[number], id: string) =>
          validateTarget(change, id).length === 0;
        const adjacentAnchors = familyAnchors.filter((anchor) => anchor.shiftId === first.shift.id &&
          anchor.family === first.edit.family &&
          (anchor.hour === range[0]!.edit.hour - 1 || anchor.hour === range.at(-1)!.edit.hour + 1))
          .sort((a, b) => a.hour - b.hour);
        const preference = [...new Set(adjacentAnchors.map((anchor) => anchor.stationId))];
        const continuous = [...preference, ...ids].find((id) =>
          range.every((change) => available(change, id)));
        for (const change of range) {
          const chosen = continuous ?? ids.find((id) => available(change, id));
          if (!chosen) {
            const forbidden = ids.every((id) =>
              abilityByKey.get(`${change.shift.employeeId}|${id}`) === "forbidden",
            );
            return invalid(forbidden ? "FORBIDDEN_ABILITY" : "STATION_FULL",
              forbidden ? "This person cannot work in this position family." :
                "All numbered positions are occupied for this hour. Nothing was saved.");
          }
          change.stationId = chosen;
          reserve(chosen, change.hourStart);
        }
      }

      // Reserve numbers people already show in a family before any newcomer
      // in this save is numbered. Request order must not steal a retained number.
      const planned = planPaintSeatNumbers(
        changes.map((change, index) => ({
          key: String(index),
          employeeId: change.shift.employeeId,
          hourStartMs: change.hourStart.getTime(),
          stationId: change.stationId,
          previous: change.current
            ? {
                id: change.current.id,
                stationId: change.current.stationId,
                seatNumber: change.current.seatNumber,
              }
            : null,
        })),
        remaining.flatMap((row) => row.employeeId ? [{
          id: row.id,
          employeeId: row.employeeId,
          stationId: row.stationId,
          hourStartMs: row.hourStart.getTime(),
          seatNumber: row.seatNumber,
        }] : []),
      );
      for (const row of planned.persist) {
        await tx.assignment.update({ where: { id: row.id }, data: { seatNumber: row.seatNumber } });
      }

      // Delete first, then recreate with the same ids. This also allows two
      // occupied positions to trade places without an intermediate unique hit.
      const deleteIds = changes.map((change) => change.current?.id).filter((id): id is string => id != null);
      if (deleteIds.length > 0) {
        await tx.assignment.deleteMany({ where: { id: { in: deleteIds } } });
      }
      for (const [index, { edit, shift, hourStart, current, stationId }] of changes.entries()) {
        if (current && !isFutureHour(hourStart, now)) {
          await tx.positionMoveLog.create({
            data: {
              date: request.date,
              hour: edit.hour,
              employeeId: shift.employeeId,
              fromStationId: current.stationId,
              toStationId: stationId,
              assignmentId: current.id,
              reason: edit.reason as MoveReason,
              note: edit.note?.trim() || null,
            },
          });
        }
        if (stationId) {
          const seatNumber = planned.numbers.get(String(index)) ?? null;
          await tx.assignment.create({
            data: {
              ...(current ? { id: current.id } : {}),
              shiftId: shift.id,
              employeeId: shift.employeeId,
              stationId,
              hourStart,
              hourEnd: chicagoHourEnd(request.date, edit.hour),
              seatNumber,
            },
          });
        }
      }
      if (actor) {
        const hours = [...new Set(request.edits.map((edit) => edit.hour))];
        const stations = [...new Set(changes.map((change) => change.stationId).filter((id): id is string => id != null))];
        await writeBoardChange(tx, actor, {
          date: request.date,
          hour: hours.length === 1 ? hours[0] : null,
          stationId: stations.length === 1 ? stations[0] : null,
          count: changes.length,
        });
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
