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

  const shift = await prisma.shift.findUnique({
    where: { id: params.shiftId },
    include: { employee: true },
  });
  if (!shift) {
    return {
      ok: false,
      status: 404,
      violations: [{ code: "SHIFT_NOT_FOUND", message: "Shift not found" }],
    };
  }

  const station = await prisma.station.findUnique({
    where: { id: params.stationId },
  });
  if (!station) {
    return {
      ok: false,
      status: 404,
      violations: [{ code: "STATION_NOT_FOUND", message: "Station not found" }],
    };
  }

  const hourStart = chicagoHourStart(params.date, params.hour);
  const hourEnd = chicagoHourEnd(params.date, params.hour);

  const [occupancy, personAssignments, ability] = await Promise.all([
    prisma.assignment.count({
      where: { stationId: params.stationId, hourStart },
    }),
    prisma.assignment.findMany({
      where: {
        hourStart,
        shift: { employeeId: shift.employeeId },
      },
    }),
    prisma.employeeStationAbility.findUnique({
      where: {
        employeeId_stationId: {
          employeeId: shift.employeeId,
          stationId: params.stationId,
        },
      },
    }),
  ]);

  const violations = validateAssignment({
    hourStart,
    shiftStart: shift.startAt,
    shiftEnd: shift.endAt,
    stationId: station.id,
    stationBoard: station.board,
    shiftBoard: shift.board,
    maxConcurrent: station.maxConcurrent,
    existingOccupancy: occupancy,
    abilityLevel: (ability?.level as AbilityLevel | undefined) ?? null,
    personAlreadyAssignedAtHour: personAssignments.length > 0,
    chicagoHour: chicagoHourOf(hourStart),
  });

  if (violations.length > 0) {
    return { ok: false, status: 422, violations };
  }

  const assignment = await prisma.assignment.create({
    data: {
      shiftId: params.shiftId,
      stationId: params.stationId,
      hourStart,
      hourEnd,
    },
  });

  return { ok: true, assignment: toDto(assignment) };
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

  // After swap: A.station gets B's shift, B.station gets A's shift
  const plan = [
    { station: a.station, shift: b.shift, hourStart: a.hourStart, keepId: a.id },
    { station: b.station, shift: a.shift, hourStart: b.hourStart, keepId: b.id },
  ] as const;

  for (const p of plan) {
    const ability = await prisma.employeeStationAbility.findUnique({
      where: {
        employeeId_stationId: {
          employeeId: p.shift.employeeId,
          stationId: p.station.id,
        },
      },
    });

    // Occupancy: exclude both swap partners at this station+hour
    const occupancy = await prisma.assignment.count({
      where: {
        stationId: p.station.id,
        hourStart: p.hourStart,
        NOT: { id: { in: [a.id, b.id] } },
      },
    });

    // Person already assigned elsewhere at this hour (excluding the two swap rows)
    const otherPerson = await prisma.assignment.count({
      where: {
        hourStart: p.hourStart,
        shift: { employeeId: p.shift.employeeId },
        NOT: { id: { in: [a.id, b.id] } },
      },
    });

    const violations = validateAssignment({
      hourStart: p.hourStart,
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
    if (violations.length > 0) {
      return { ok: false, status: 422, violations };
    }
  }

  // Perform swap of shiftIds
  const updated = await prisma.$transaction(async (tx) => {
    const u1 = await tx.assignment.update({
      where: { id: a.id },
      data: { shiftId: b.shiftId },
    });
    const u2 = await tx.assignment.update({
      where: { id: b.id },
      data: { shiftId: a.shiftId },
    });
    return [u1, u2] as const;
  });

  return {
    ok: true,
    assignments: [toDto(updated[0]), toDto(updated[1])],
  };
}
