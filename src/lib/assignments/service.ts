import { prisma } from "@/lib/db";
import { validateAssignment } from "@/lib/rules/assign";
import type { AbilityLevel, RuleViolation } from "@/lib/rules/types";
import { chicagoHourOf, chicagoHourStart, chicagoHourEnd } from "@/lib/hour-grid";
import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";

export type AssignParams = {
  shiftId: string;
  stationId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Chicago wall hour 7–21 */
  hour: number;
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

/**
 * Swap the people (shiftIds) on two assignments at the same hour,
 * re-validating abilities and shift windows for the swapped targets.
 */
export async function swapAssignments(
  assignmentIdA: string,
  assignmentIdB: string,
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
