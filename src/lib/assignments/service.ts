import { boardWrite, acquireBoardWrite } from "@/lib/shared-write";
import { requireLegacy } from "@/lib/quarter/schema";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { validateAssignment } from "@/lib/rules/assign";
import type { RuleViolation } from "@/lib/rules/types";
import { chicagoHourOf, chicagoHourStart, chicagoHourEnd, hourGridHours } from "@/lib/hour-grid";
import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";
import { isFutureHour } from "@/lib/rules/live-hour";
import { isHourInShift } from "@/lib/rules/shift-window";
import { isValidMoveReason, type MoveReason } from "@/lib/position-moves";
import { chicagoYmd } from "@/lib/schedule/build-schedule";
import { writeBoardChange, type BoardChangeActor } from "@/lib/board-change-log";
import { familyForStation } from "@/lib/assignments/paint-families";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { carriedSeatNumber, numberedFamilySeats, seatNumberForWrite } from "@/lib/assignments/seat-number";

/** Caller-owned transaction. A helper that receives one must not open another. */
export type AssignmentTx = Prisma.TransactionClient;

export type AssignParams = {
  shiftId: string;
  stationId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Chicago wall hour 7–21 */
  hour: number;
  /** Injectable clock (tests). */
  now?: Date;
  /** Set by PUT /api/assignments so the log shares this write's transaction. */
  actor?: BoardChangeActor;
  /** When set, this write joins the caller's transaction instead of opening one. */
  db?: AssignmentTx;
};

export type AssignResult =
  | { ok: true; assignment: AssignmentDto }
  | { ok: false; status: 404 | 422; violations: RuleViolation[] };

export type AssignmentDto = {
  id: string;
  shiftId: string;
  stationId: string;
  hourStart: string;
  hourEnd: string;
  seatNumber: number | null;
};

const supersededViolation: RuleViolation = {
  code: "SHIFT_SUPERSEDED",
  message: "This shift was replaced by a newer schedule. Assign the person's current shift instead.",
};

const removedViolation: RuleViolation = {
  code: "SHIFT_REMOVED",
  message: "This shift was removed from board service. Refresh and ask a manager to restore it first.",
};

/** A superseded shift keeps its started hours as history and takes no future hour (C1). */
function refusesFutureHour(
  shift: { supersededAt: Date | null },
  hourStart: Date,
  now: Date,
): boolean {
  return shift.supersededAt != null && now.getTime() < hourStart.getTime();
}

const conflictViolation = (code: "STATION_FULL" | "PERSON_ALREADY_ASSIGNED"): RuleViolation =>
  code === "STATION_FULL"
    ? { code, message: "That station was just assigned by another tablet. Refresh and choose another station." }
    : { code, message: "That person was just assigned by another tablet. Refresh the board." };

function isUniqueConflict(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2002",
  );
}

function toDto(a: {
  id: string;
  shiftId: string;
  stationId: string;
  hourStart: Date;
  hourEnd: Date;
  seatNumber?: number | null;
}): AssignmentDto {
  return {
    id: a.id,
    shiftId: a.shiftId,
    stationId: a.stationId,
    hourStart: a.hourStart.toISOString(),
    hourEnd: a.hourEnd.toISOString(),
    seatNumber: a.seatNumber ?? null,
  };
}

export async function createAssignment(
  params: AssignParams,
): Promise<AssignResult> {
  if (params.hour < HOUR_GRID_START || params.hour >= HOUR_GRID_END) {
    return {
      ok: false,
      status: 422,
      violations: [
        {
          code: "INVALID_HOUR",
          message: `Hour ${params.hour} is outside the board grid`,
        },
      ],
    };
  }

  const hourStart = chicagoHourStart(params.date, params.hour);
  const hourEnd = chicagoHourEnd(params.date, params.hour);
  const write = async (tx: AssignmentTx): Promise<AssignResult> => {
      await requireLegacy(tx);
      const shift = await tx.shift.findUnique({ where: { id: params.shiftId } });
      if (!shift) return { ok: false, status: 404, violations: [{ code: "SHIFT_NOT_FOUND", message: "Shift not found" }] } as const;
      if (shift.boardRemoved) return { ok: false, status: 422, violations: [removedViolation] } as const;
      if (refusesFutureHour(shift, hourStart, params.now ?? new Date())) {
        return { ok: false, status: 422, violations: [supersededViolation] } as const;
      }
      const station = await tx.station.findUnique({ where: { id: params.stationId } });
      if (!station) return { ok: false, status: 404, violations: [{ code: "STATION_NOT_FOUND", message: "Station not found" }] } as const;
      const [occupancy, personAssignments, ability, columnDefaults] = await Promise.all([
        tx.assignment.count({ where: { stationId: params.stationId, hourStart } }),
        tx.assignment.count({ where: { hourStart, employeeId: shift.employeeId } }),
        tx.employeeStationAbility.findUnique({ where: { employeeId_stationId: { employeeId: shift.employeeId, stationId: params.stationId } } }),
        loadColumnDefaults(tx),
      ]);
      const violations = validateAssignment({
        hourStart, hourEnd, shiftStart: shift.startAt, shiftEnd: shift.endAt,
        stationId: station.id, stationBoard: station.board, shiftBoard: shift.board,
        maxConcurrent: station.maxConcurrent, existingOccupancy: occupancy,
        abilityLevel: levelWhenUnset(ability?.level, columnDefaults.get(params.stationId)),
        personAlreadyAssignedAtHour: personAssignments > 0,
        chicagoHour: chicagoHourOf(hourStart),
      });
      if (violations.length > 0) return { ok: false, status: 422, violations } as const;
      const seatNumber = await seatNumberForWrite(tx, {
        stationId: params.stationId,
        hourStart,
        employeeId: shift.employeeId,
      });
      const assignment = await tx.assignment.create({
        data: { shiftId: params.shiftId, employeeId: shift.employeeId, stationId: params.stationId, hourStart, hourEnd, seatNumber },
      });
      if (params.actor) {
        await writeBoardChange(tx, params.actor, {
          date: params.date,
          hour: params.hour,
          stationId: params.stationId,
          count: 1,
        });
      }
      return { ok: true, assignment: toDto(assignment) } as const;
  };
  try {
    if (params.db) { await acquireBoardWrite(params.db); return await write(params.db); }
    return await boardWrite(prisma, write);
  } catch (error) {
    if (isUniqueConflict(error)) {
      return { ok: false, status: 422, violations: [conflictViolation("STATION_FULL")] };
    }
    throw error;
  }
}

export type ShiftAssignParams = {
  shiftId: string;
  stationId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Injectable clock (tests). */
  now?: Date;
  actor?: BoardChangeActor;
  /** When set, the caller owns the transaction and writes the log row. */
  db?: AssignmentTx;
};

export type ShiftAssignSummary = {
  /** Hours newly placed at this station this call. */
  placed: number;
  /** Hours already seating this same person at this station (idempotent retry). */
  alreadyThere: number;
  /** Hours skipped because the station already had someone else. */
  stationOccupied: number;
  /** Hours skipped because this person already had a different station that hour. */
  personBusy: number;
  /** Hours skipped because a superseded shift takes no new future hour (C1). */
  superseded: number;
};

export type ShiftAssignResult =
  | { ok: true; summary: ShiftAssignSummary }
  | { ok: false; status: 404 | 422; violations: RuleViolation[] };

/**
 * Planner A: place a shift's whole overlap with the grid at one station, one
 * hour-row per grid hour (the same rows `createAssignment` writes today, so
 * every other reader — Rush, the ledger, the timeline — sees no new shape).
 * Hours are skipped, not failed: an occupied station, a person already
 * seated elsewhere, or a future hour on a superseded shift each just leave
 * that one row unwritten. A forbidden ability is checked once, up front,
 * and writes nothing at all.
 */
export async function createShiftAssignment(
  params: ShiftAssignParams,
): Promise<ShiftAssignResult> {
  const run = async (tx: AssignmentTx): Promise<ShiftAssignResult> => {
    await requireLegacy(tx);
    const shift = await tx.shift.findUnique({ where: { id: params.shiftId } });
    if (!shift) {
      return { ok: false, status: 404, violations: [{ code: "SHIFT_NOT_FOUND", message: "Shift not found" }] };
    }
    if (shift.boardRemoved) return { ok: false, status: 422, violations: [removedViolation] };
    const station = await tx.station.findUnique({ where: { id: params.stationId } });
    if (!station) {
      return { ok: false, status: 404, violations: [{ code: "STATION_NOT_FOUND", message: "Station not found" }] };
    }
    if (station.board !== shift.board) {
      return { ok: false, status: 422, violations: [{ code: "STATION_BOARD_MISMATCH", message: "That station belongs to the other board" }] };
    }

    const [ability, columnDefaults] = await Promise.all([
      tx.employeeStationAbility.findUnique({
        where: { employeeId_stationId: { employeeId: shift.employeeId, stationId: params.stationId } },
      }),
      loadColumnDefaults(tx),
    ]);
    if (levelWhenUnset(ability?.level, columnDefaults.get(params.stationId)) === "forbidden") {
      return { ok: false, status: 422, violations: [{ code: "FORBIDDEN_ABILITY", message: "This person can't work that station" }] };
    }

    const overlappingHours = hourGridHours().filter((hour) => {
      const hourStart = chicagoHourStart(params.date, hour);
      const hourEnd = chicagoHourEnd(params.date, hour);
      return isHourInShift(hourStart, shift.startAt, shift.endAt, hourEnd);
    });
    if (overlappingHours.length === 0) {
      return { ok: false, status: 422, violations: [{ code: "OUT_OF_SHIFT", message: "This shift has no hours on the board grid" }] };
    }

    const summary: ShiftAssignSummary = {
      placed: 0,
      alreadyThere: 0,
      stationOccupied: 0,
      personBusy: 0,
      superseded: 0,
    };
    for (const hour of overlappingHours) {
      const hourStart = chicagoHourStart(params.date, hour);
      const already = await tx.assignment.findFirst({
        where: { stationId: params.stationId, hourStart, employeeId: shift.employeeId },
      });
      if (already) {
        summary.alreadyThere += 1;
        continue;
      }
      const result = await createAssignment({
        shiftId: params.shiftId,
        stationId: params.stationId,
        date: params.date,
        hour,
        now: params.now,
        db: tx,
      });
      if (result.ok) {
        summary.placed += 1;
        continue;
      }
      if (result.violations.some((v) => v.code === "SHIFT_REMOVED")) {
        return { ok: false, status: 422, violations: [removedViolation] };
      }
      if (result.violations.some((v) => v.code === "PERSON_ALREADY_ASSIGNED")) {
        summary.personBusy += 1;
      } else if (result.violations.some((v) => v.code === "SHIFT_SUPERSEDED")) {
        summary.superseded += 1;
      } else {
        summary.stationOccupied += 1;
      }
    }
    if (params.actor && !params.db) {
      await writeBoardChange(tx, params.actor, {
        date: params.date,
        stationId: params.stationId,
        count: summary.placed,
      });
    }
    return { ok: true, summary };
  };

  if (params.db) { await acquireBoardWrite(params.db); return run(params.db); }
  return boardWrite(prisma, run);
}

export type CopyDayParams = {
  board: string;
  sourceDate: string;
  targetDate: string;
  now?: Date;
  actor?: BoardChangeActor;
};

export type CopyDaySummary = {
  /** Newly placed on the target day. */
  copied: number;
  /** The person has no shift overlapping that hour on the target day. */
  noShift: number;
  /** The target hour+station already holds someone else — left untouched. */
  occupied: number;
  /** The target hour+station already holds this same person — left untouched. */
  alreadyThere: number;
  /** This person can't work that station — nothing written for that hour. */
  forbidden: number;
};

export type CopyDayResult =
  | { ok: true; summary: CopyDaySummary }
  | { ok: false; status: 422; error: string };

/**
 * Planner B: copy a source day's placements onto the target day, for people
 * who have an overlapping shift there. Never overwrites — a target hour that
 * already has a row (this person's or anyone else's) is left byte for byte.
 * Reuses `createAssignment`'s own rules for every write, so a copy can never
 * place something the floor's own assign button would refuse.
 */
export async function copyDayAssignments(
  params: CopyDayParams,
): Promise<CopyDayResult> {
  if (params.sourceDate === params.targetDate) {
    return { ok: false, status: 422, error: "Source and target day must differ" };
  }
  return boardWrite(prisma, async (tx) => {
    await requireLegacy(tx);
    const dayStart = chicagoHourStart(params.sourceDate, HOUR_GRID_START);
    const dayEnd = chicagoHourStart(params.sourceDate, HOUR_GRID_END);
    const sourceAssignments = await tx.assignment.findMany({
      where: {
        station: { board: params.board },
        shift: { boardRemoved: false },
        hourStart: { gte: dayStart, lt: dayEnd },
      },
    });

    const summary: CopyDaySummary = {
      copied: 0,
      noShift: 0,
      occupied: 0,
      alreadyThere: 0,
      forbidden: 0,
    };

    for (const source of sourceAssignments) {
      if (!source.employeeId) {
        summary.noShift += 1;
        continue;
      }
      const hour = chicagoHourOf(source.hourStart);
      const targetHourStart = chicagoHourStart(params.targetDate, hour);
      const targetHourEnd = chicagoHourEnd(params.targetDate, hour);

      const existing = await tx.assignment.findFirst({
        where: { stationId: source.stationId, hourStart: targetHourStart },
      });
      if (existing) {
        if (existing.employeeId === source.employeeId) {
          summary.alreadyThere += 1;
        } else {
          summary.occupied += 1;
        }
        continue;
      }

      const targetShifts = await tx.shift.findMany({
        where: {
          employeeId: source.employeeId,
          date: params.targetDate,
          board: params.board,
          supersededAt: null,
          boardRemoved: false,
        },
      });
      const targetShift = targetShifts.find((s) =>
        isHourInShift(targetHourStart, s.startAt, s.endAt, targetHourEnd),
      );
      if (!targetShift) {
        summary.noShift += 1;
        continue;
      }

      const result = await createAssignment({
        shiftId: targetShift.id,
        stationId: source.stationId,
        date: params.targetDate,
        hour,
        now: params.now,
        db: tx,
      });
      if (result.ok) {
        summary.copied += 1;
      } else if (result.violations.some((v) => v.code === "FORBIDDEN_ABILITY")) {
        summary.forbidden += 1;
      } else if (result.violations.some((v) => v.code === "PERSON_ALREADY_ASSIGNED")) {
        summary.alreadyThere += 1;
      } else {
        summary.occupied += 1;
      }
    }

    if (params.actor) {
      await writeBoardChange(tx, params.actor, {
        date: params.targetDate,
        count: summary.copied,
      });
    }
    return { ok: true as const, summary };
  });
}

export async function deleteAssignment(
  id: string,
): Promise<
  | { ok: true; id: string }
  | { ok: false; status: 404 | 422; violations: RuleViolation[] }
> {
  return boardWrite(prisma, async tx => {
  await requireLegacy(tx);
  const existing = await tx.assignment.findUnique({ where: { id }, include: { shift: true } });
  if (!existing) {
    return {
      ok: false,
      status: 404,
      violations: [
        { code: "ASSIGNMENT_NOT_FOUND", message: "Assignment not found" },
      ],
    };
  }
  if (existing.shift.boardRemoved) return { ok: false, status: 422, violations: [removedViolation] };
  await tx.assignment.delete({ where: { id } });
  return { ok: true, id };
  });
}

export type ClearAssignmentParams = {
  id: string;
  reason?: string | null;
  note?: string | null;
  now?: Date;
  actor?: BoardChangeActor;
};

export type ClearAssignmentResult =
  | { ok: true; id: string }
  | { ok: false; status: 404 | 422; error: string };

/**
 * Floor clear button (Planner E). A future hour needs no reason and writes
 * no PositionMoveLog row — one tap. The current hour and any past hour keep
 * the Phase 1 rule: a valid reason is required, and the log row is written
 * in the same transaction as the delete, so the two can never diverge.
 * "Future" is decided by the server clock against the assignment's own
 * hourStart (same test as import's hasStarted) — never a client flag.
 */
export async function clearAssignment(
  params: ClearAssignmentParams,
): Promise<ClearAssignmentResult> {
  return boardWrite(prisma, async tx => {
  await requireLegacy(tx);
  const existing = await tx.assignment.findUnique({ where: { id: params.id }, include: { shift: true } });
  if (!existing) {
    return { ok: false, status: 404, error: "Assignment not found" };
  }
  if (existing.shift.boardRemoved) {
    return { ok: false, status: 422, error: removedViolation.message };
  }
  const now = params.now ?? new Date();
  if (isFutureHour(existing.hourStart, now)) {
      await tx.assignment.delete({ where: { id: params.id } });
      if (params.actor) {
        await writeBoardChange(tx, params.actor, {
          date: chicagoYmd(existing.hourStart),
          hour: chicagoHourOf(existing.hourStart),
          stationId: existing.stationId,
          count: 1,
        });
      }
    return { ok: true, id: params.id };
  }
  const reason = params.reason ?? "";
  if (!isValidMoveReason(reason)) {
    return {
      ok: false,
      status: 422,
      error: "A reason is required to clear the current or a past hour",
    };
  }
  const employeeId = existing.employeeId;
  if (!employeeId) {
    return {
      ok: false,
      status: 422,
      error: "This assignment has no employee on record and cannot be logged",
    };
  }
    await tx.positionMoveLog.create({
      data: {
        date: chicagoYmd(existing.hourStart),
        hour: chicagoHourOf(existing.hourStart),
        employeeId,
        fromStationId: existing.stationId,
        toStationId: null,
        assignmentId: existing.id,
        reason: reason as MoveReason,
        note: params.note?.trim() || null,
      },
    });
    await tx.assignment.delete({ where: { id: params.id } });
    if (params.actor) {
      await writeBoardChange(tx, params.actor, {
        date: chicagoYmd(existing.hourStart),
        hour: chicagoHourOf(existing.hourStart),
        stationId: existing.stationId,
        count: 1,
      });
    }
  return { ok: true, id: params.id };
  });
}

/**
 * Swap the people (shiftIds) on two assignments at the same hour,
 * re-validating abilities and shift windows for the swapped targets.
 */
export async function swapAssignments(
  assignmentIdA: string,
  assignmentIdB: string,
  now: Date = new Date(),
  actor?: BoardChangeActor,
): Promise<
  | { ok: true; assignments: [AssignmentDto, AssignmentDto] }
  | { ok: false; status: 404 | 422; violations: RuleViolation[] }
> {
  if (assignmentIdA === assignmentIdB) {
    return {
      ok: false,
      status: 422,
      violations: [
        {
          code: "SWAP_SAME_ASSIGNMENT",
          message: "Cannot swap an assignment with itself",
        },
      ],
    };
  }

  await requireLegacy(prisma);
  const [a, b] = await Promise.all([
    prisma.assignment.findUnique({
      where: { id: assignmentIdA },
      include: { shift: true, station: true },
    }),
    prisma.assignment.findUnique({
      where: { id: assignmentIdB },
      include: { shift: true, station: true },
    }),
  ]);

  if (!a || !b) {
    return {
      ok: false,
      status: 404,
      violations: [
        { code: "ASSIGNMENT_NOT_FOUND", message: "One or both assignments not found" },
      ],
    };
  }
  if (a.shift.boardRemoved || b.shift.boardRemoved) {
    return { ok: false, status: 422, violations: [removedViolation] };
  }

  try {
    return await boardWrite(prisma, async (tx) => {
    await requireLegacy(tx);
      const current = await tx.assignment.findMany({
        where: { id: { in: [a.id, b.id] } }, include: { shift: true, station: true },
      });
      if (current.length !== 2) {
        return { ok: false, status: 404, violations: [{ code: "ASSIGNMENT_NOT_FOUND", message: "One or both assignments no longer exist" }] } as const;
      }
      const [currentA, currentB] = current[0]!.id === a.id ? [current[0]!, current[1]!] : [current[1]!, current[0]!];
      if (currentA.shift.boardRemoved || currentB.shift.boardRemoved) {
        return { ok: false, status: 422, violations: [removedViolation] } as const;
      }
      const plan = [
        { station: currentA.station, shift: currentB.shift, hourStart: currentA.hourStart },
        { station: currentB.station, shift: currentA.shift, hourStart: currentB.hourStart },
      ] as const;
      for (const p of plan) {
        if (refusesFutureHour(p.shift, p.hourStart, now)) {
          return { ok: false, status: 422, violations: [supersededViolation] } as const;
        }
        const [ability, columnDefaults] = await Promise.all([
          tx.employeeStationAbility.findUnique({
            where: {
              employeeId_stationId: {
                employeeId: p.shift.employeeId,
                stationId: p.station.id,
              },
            },
          }),
          loadColumnDefaults(tx),
        ]);

    // Occupancy: exclude both swap partners at this station+hour
        const occupancy = await tx.assignment.count({
      where: {
        stationId: p.station.id,
        hourStart: p.hourStart,
        NOT: { id: { in: [a.id, b.id] } },
      },
    });

    // Person already assigned elsewhere at this hour (excluding the two swap rows)
        const otherPerson = await tx.assignment.count({
      where: {
        hourStart: p.hourStart,
        shift: { employeeId: p.shift.employeeId },
        NOT: { id: { in: [a.id, b.id] } },
      },
    });

        const violations = validateAssignment({
      hourStart: p.hourStart,
      hourEnd: new Date(p.hourStart.getTime() + 60 * 60_000),
      shiftStart: p.shift.startAt,
      shiftEnd: p.shift.endAt,
      stationId: p.station.id,
      stationBoard: p.station.board,
      shiftBoard: p.shift.board,
      maxConcurrent: p.station.maxConcurrent,
      existingOccupancy: occupancy,
      updatingExistingOnStation: false,
      abilityLevel: levelWhenUnset(ability?.level, columnDefaults.get(p.station.id)),
      personAlreadyAssignedAtHour: otherPerson > 0,
      chicagoHour: chicagoHourOf(p.hourStart),
    });

    // Station will hold this one new person after swap — occupancy already excludes both,
    // so we need room for +1. validateAssignment with existingOccupancy already handles it.
        if (violations.length > 0) return { ok: false, status: 422, violations } as const;
      }
      const seatsA = numberedFamilySeats(currentA.stationId);
      const seatsB = numberedFamilySeats(currentB.stationId);
      const peerWhere = [
        seatsA ? { hourStart: currentA.hourStart, stationId: { in: [...seatsA] } } : null,
        seatsB ? { hourStart: currentB.hourStart, stationId: { in: [...seatsB] } } : null,
      ].filter((clause): clause is NonNullable<typeof clause> => clause != null);
      const peerRows = peerWhere.length > 0
        ? await tx.assignment.findMany({
            where: { OR: peerWhere },
            select: { id: true, stationId: true, hourStart: true, seatNumber: true },
          })
        : [];
      const peersAt = (hourStart: Date) => peerRows
        .filter((row) => row.hourStart.getTime() === hourStart.getTime())
        .map((row) => ({ id: row.id, stationId: row.stationId, seatNumber: row.seatNumber }));
      const sameFamilyHour = currentA.hourStart.getTime() === currentB.hourStart.getTime()
        && familyForStation(currentA.stationId) != null
        && familyForStation(currentA.stationId) === familyForStation(currentB.stationId);
      const priorOnA = carriedSeatNumber({
        fromStationId: currentB.stationId,
        toStationId: currentA.stationId,
        row: currentB,
        peers: peersAt(currentB.hourStart),
        hourStartMs: currentB.hourStart.getTime(),
      });
      const priorOnB = carriedSeatNumber({
        fromStationId: currentA.stationId,
        toStationId: currentB.stationId,
        row: currentA,
        peers: peersAt(currentA.hourStart),
        hourStartMs: currentA.hourStart.getTime(),
      });
      const ignoreIds = [currentA.id, currentB.id];
      const numberOnA = await seatNumberForWrite(tx, {
        stationId: currentA.stationId,
        hourStart: currentA.hourStart,
        employeeId: currentB.shift.employeeId,
        prior: priorOnA,
        ignoreIds,
        reserved: sameFamilyHour && priorOnB != null ? [priorOnB] : [],
      });
      const numberOnB = await seatNumberForWrite(tx, {
        stationId: currentB.stationId,
        hourStart: currentB.hourStart,
        employeeId: currentA.shift.employeeId,
        prior: priorOnB,
        ignoreIds,
        reserved: sameFamilyHour && priorOnA != null ? [priorOnA] : [],
      });
      // Clear unique person claims before exchanging rows, then restore them atomically.
      await tx.assignment.updateMany({ where: { id: { in: [currentA.id, currentB.id] } }, data: { employeeId: null } });
      const u1 = await tx.assignment.update({ where: { id: currentA.id }, data: { shiftId: currentB.shiftId, employeeId: currentB.shift.employeeId, seatNumber: numberOnA } });
      const u2 = await tx.assignment.update({ where: { id: currentB.id }, data: { shiftId: currentA.shiftId, employeeId: currentA.shift.employeeId, seatNumber: numberOnB } });
      if (actor) {
        await writeBoardChange(tx, actor, {
          date: chicagoYmd(currentA.hourStart),
          hour: chicagoHourOf(currentA.hourStart),
          stationId: `${currentA.stationId},${currentB.stationId}`,
          count: 2,
        });
      }
      return { ok: true, assignments: [toDto(u1), toDto(u2)] } as const;
    });
  } catch (error) {
    if (isUniqueConflict(error)) return { ok: false, status: 422, violations: [conflictViolation("PERSON_ALREADY_ASSIGNED")] };
    throw error;
  }
}
