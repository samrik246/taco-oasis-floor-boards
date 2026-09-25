import { prisma } from "@/lib/db";
import { validateAssignment } from "@/lib/rules/assign";
import type { AbilityLevel, RuleViolation } from "@/lib/rules/types";
import { chicagoHourOf, chicagoHourStart, chicagoHourEnd, hourGridHours } from "@/lib/hour-grid";
import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";
import { isFutureHour } from "@/lib/rules/live-hour";
import { isHourInShift } from "@/lib/rules/shift-window";
import { isValidMoveReason, type MoveReason } from "@/lib/position-moves";
import { chicagoYmd } from "@/lib/schedule/build-schedule";

export type AssignParams = {
  shiftId: string;
  stationId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Chicago wall hour 7–21 */
  hour: number;
  /** Injectable clock (tests). */
  now?: Date;
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
};

const supersededViolation: RuleViolation = {
  code: "SHIFT_SUPERSEDED",
  message: "This shift was replaced by a newer schedule. Assign the person's current shift instead.",
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
}): AssignmentDto {
  return {
    id: a.id,
    shiftId: a.shiftId,
    stationId: a.stationId,
    hourStart: a.hourStart.toISOString(),
    hourEnd: a.hourEnd.toISOString(),
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
  try {
    return await prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findUnique({ where: { id: params.shiftId } });
      if (!shift) return { ok: false, status: 404, violations: [{ code: "SHIFT_NOT_FOUND", message: "Shift not found" }] } as const;
      if (refusesFutureHour(shift, hourStart, params.now ?? new Date())) {
        return { ok: false, status: 422, violations: [supersededViolation] } as const;
      }
      const station = await tx.station.findUnique({ where: { id: params.stationId } });
      if (!station) return { ok: false, status: 404, violations: [{ code: "STATION_NOT_FOUND", message: "Station not found" }] } as const;
      const [occupancy, personAssignments, ability] = await Promise.all([
        tx.assignment.count({ where: { stationId: params.stationId, hourStart } }),
        tx.assignment.count({ where: { hourStart, employeeId: shift.employeeId } }),
        tx.employeeStationAbility.findUnique({ where: { employeeId_stationId: { employeeId: shift.employeeId, stationId: params.stationId } } }),
      ]);
      const violations = validateAssignment({
        hourStart, hourEnd, shiftStart: shift.startAt, shiftEnd: shift.endAt,
        stationId: station.id, stationBoard: station.board, shiftBoard: shift.board,
        maxConcurrent: station.maxConcurrent, existingOccupancy: occupancy,
        abilityLevel: (ability?.level as AbilityLevel | undefined) ?? null,
        personAlreadyAssignedAtHour: personAssignments > 0,
        chicagoHour: chicagoHourOf(hourStart),
      });
      if (violations.length > 0) return { ok: false, status: 422, violations } as const;
      const assignment = await tx.assignment.create({
        data: { shiftId: params.shiftId, employeeId: shift.employeeId, stationId: params.stationId, hourStart, hourEnd },
      });
      return { ok: true, assignment: toDto(assignment) } as const;
    });
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
  const shift = await prisma.shift.findUnique({ where: { id: params.shiftId } });
  if (!shift) {
    return { ok: false, status: 404, violations: [{ code: "SHIFT_NOT_FOUND", message: "Shift not found" }] };
  }
  const station = await prisma.station.findUnique({ where: { id: params.stationId } });
  if (!station) {
    return { ok: false, status: 404, violations: [{ code: "STATION_NOT_FOUND", message: "Station not found" }] };
  }
  if (station.board !== shift.board) {
    return { ok: false, status: 422, violations: [{ code: "STATION_BOARD_MISMATCH", message: "That station belongs to the other board" }] };
  }

  const ability = await prisma.employeeStationAbility.findUnique({
    where: { employeeId_stationId: { employeeId: shift.employeeId, stationId: params.stationId } },
  });
  if ((ability?.level as AbilityLevel | undefined) === "forbidden") {
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
    const already = await prisma.assignment.findFirst({
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
    });
    if (result.ok) {
      summary.placed += 1;
      continue;
    }
    if (result.violations.some((v) => v.code === "PERSON_ALREADY_ASSIGNED")) {
      summary.personBusy += 1;
    } else if (result.violations.some((v) => v.code === "SHIFT_SUPERSEDED")) {
      summary.superseded += 1;
    } else {
      summary.stationOccupied += 1;
    }
  }
  return { ok: true, summary };
}

export type CopyDayParams = {
  board: string;
  sourceDate: string;
  targetDate: string;
  now?: Date;
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
  const dayStart = chicagoHourStart(params.sourceDate, HOUR_GRID_START);
  const dayEnd = chicagoHourStart(params.sourceDate, HOUR_GRID_END);
  const sourceAssignments = await prisma.assignment.findMany({
    where: {
      station: { board: params.board },
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

    const existing = await prisma.assignment.findFirst({
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

    const targetShifts = await prisma.shift.findMany({
      where: { employeeId: source.employeeId, date: params.targetDate },
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
    });
    if (result.ok) {
      summary.copied += 1;
    } else if (result.violations.some((v) => v.code === "FORBIDDEN_ABILITY")) {
      summary.forbidden += 1;
    } else {
      summary.occupied += 1;
    }
  }

  return { ok: true, summary };
}

export async function deleteAssignment(
  id: string,
): Promise<
  | { ok: true; id: string }
  | { ok: false; status: 404; violations: RuleViolation[] }
> {
  const existing = await prisma.assignment.findUnique({ where: { id } });
  if (!existing) {
    return {
      ok: false,
      status: 404,
      violations: [
        { code: "ASSIGNMENT_NOT_FOUND", message: "Assignment not found" },
      ],
    };
  }
  await prisma.assignment.delete({ where: { id } });
  return { ok: true, id };
}

export type ClearAssignmentParams = {
  id: string;
  reason?: string | null;
  note?: string | null;
  now?: Date;
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
  const existing = await prisma.assignment.findUnique({ where: { id: params.id } });
  if (!existing) {
    return { ok: false, status: 404, error: "Assignment not found" };
  }
  const now = params.now ?? new Date();
  if (isFutureHour(existing.hourStart, now)) {
    await prisma.assignment.delete({ where: { id: params.id } });
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
  if (!existing.employeeId) {
    return {
      ok: false,
      status: 422,
      error: "This assignment has no employee on record and cannot be logged",
    };
  }
  await prisma.$transaction([
    prisma.positionMoveLog.create({
      data: {
        date: chicagoYmd(existing.hourStart),
        hour: chicagoHourOf(existing.hourStart),
        employeeId: existing.employeeId,
        fromStationId: existing.stationId,
        toStationId: null,
        assignmentId: existing.id,
        reason: reason as MoveReason,
        note: params.note?.trim() || null,
      },
    }),
    prisma.assignment.delete({ where: { id: params.id } }),
  ]);
  return { ok: true, id: params.id };
}

/**
 * Swap the people (shiftIds) on two assignments at the same hour,
 * re-validating abilities and shift windows for the swapped targets.
 */
export async function swapAssignments(
  assignmentIdA: string,
  assignmentIdB: string,
  now: Date = new Date(),
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

  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.assignment.findMany({
        where: { id: { in: [a.id, b.id] } }, include: { shift: true, station: true },
      });
      if (current.length !== 2) {
        return { ok: false, status: 404, violations: [{ code: "ASSIGNMENT_NOT_FOUND", message: "One or both assignments no longer exist" }] } as const;
      }
      const [currentA, currentB] = current[0]!.id === a.id ? [current[0]!, current[1]!] : [current[1]!, current[0]!];
      const plan = [
        { station: currentA.station, shift: currentB.shift, hourStart: currentA.hourStart },
        { station: currentB.station, shift: currentA.shift, hourStart: currentB.hourStart },
      ] as const;
      for (const p of plan) {
        if (refusesFutureHour(p.shift, p.hourStart, now)) {
          return { ok: false, status: 422, violations: [supersededViolation] } as const;
        }
        const ability = await tx.employeeStationAbility.findUnique({
      where: {
        employeeId_stationId: {
          employeeId: p.shift.employeeId,
          stationId: p.station.id,
        },
      },
    });

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
      abilityLevel: (ability?.level as AbilityLevel | undefined) ?? null,
      personAlreadyAssignedAtHour: otherPerson > 0,
      chicagoHour: chicagoHourOf(p.hourStart),
    });

    // Station will hold this one new person after swap — occupancy already excludes both,
    // so we need room for +1. validateAssignment with existingOccupancy already handles it.
        if (violations.length > 0) return { ok: false, status: 422, violations } as const;
      }
      // Clear unique person claims before exchanging rows, then restore them atomically.
      await tx.assignment.updateMany({ where: { id: { in: [currentA.id, currentB.id] } }, data: { employeeId: null } });
      const u1 = await tx.assignment.update({ where: { id: currentA.id }, data: { shiftId: currentB.shiftId, employeeId: currentB.shift.employeeId } });
      const u2 = await tx.assignment.update({ where: { id: currentB.id }, data: { shiftId: currentA.shiftId, employeeId: currentA.shift.employeeId } });
      return { ok: true, assignments: [toDto(u1), toDto(u2)] } as const;
    });
  } catch (error) {
    if (isUniqueConflict(error)) return { ok: false, status: 422, violations: [conflictViolation("PERSON_ALREADY_ASSIGNED")] };
    throw error;
  }
}
