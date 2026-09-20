import { validateAssignment } from "@/lib/rules/assign";
import { chicagoHourOf } from "@/lib/hour-grid";
import type { AbilityLevel, RuleViolation, ViolationCode } from "@/lib/rules/types";
import type { DayBoardDto, ShiftDto, StationDto } from "@/components/board/types";

export type BoardViolation = {
  code: ViolationCode;
  message: string;
  assignmentId: string;
  employeeName: string;
  stationId: string;
  hourLabel: string;
};

function abilityLevel(
  shift: ShiftDto,
  stationId: string,
): AbilityLevel | null {
  const a = shift.employee.abilities.find((x) => x.stationId === stationId);
  return (a?.level as AbilityLevel | undefined) ?? null;
}

function chicagoHourLabel(iso: string): string {
  const h = chicagoHourOf(new Date(iso));
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${suffix}`;
}

/**
 * Scan a day board for slipped-in rule violations (SPEC slice 12).
 * Pure: re-validates each assignment against current occupancy/abilities.
 */
export function findBoardViolations(day: DayBoardDto): BoardViolation[] {
  const stationById = new Map<string, StationDto>(
    day.stations.map((s) => [s.id, s]),
  );

  type Flat = {
    assignmentId: string;
    stationId: string;
    hourStartMs: number;
    hourStartIso: string;
    shift: ShiftDto;
  };

  const flat: Flat[] = [];
  for (const sh of day.shifts) {
    for (const a of sh.assignments) {
      flat.push({
        assignmentId: a.id,
        stationId: a.stationId,
        hourStartMs: new Date(a.hourStart).getTime(),
        hourStartIso: a.hourStart,
        shift: sh,
      });
    }
  }

  const out: BoardViolation[] = [];

  for (const row of flat) {
    const station = stationById.get(row.stationId);
    if (!station) {
      out.push({
        code: "STATION_NOT_FOUND",
        message: `Assignment references missing station ${row.stationId}`,
        assignmentId: row.assignmentId,
        employeeName: `${row.shift.employee.firstName} ${row.shift.employee.lastName}`.trim(),
        stationId: row.stationId,
        hourLabel: chicagoHourLabel(row.hourStartIso),
      });
      continue;
    }

    const sameStationHour = flat.filter(
      (f) =>
        f.stationId === row.stationId && f.hourStartMs === row.hourStartMs,
    );
    // Occupancy excluding self (updatingExistingOnStation = true)
    const existingOccupancy = sameStationHour.length;
    const personElsewhere = flat.some(
      (f) =>
        f.assignmentId !== row.assignmentId &&
        f.hourStartMs === row.hourStartMs &&
        f.shift.employee.id === row.shift.employee.id,
    );

    const violations: RuleViolation[] = validateAssignment({
      hourStart: new Date(row.hourStartIso),
      shiftStart: new Date(row.shift.startAt),
      shiftEnd: new Date(row.shift.endAt),
      stationId: station.id,
      stationBoard: day.board,
      shiftBoard: row.shift.board,
      maxConcurrent: station.maxConcurrent,
      existingOccupancy,
      updatingExistingOnStation: true,
      abilityLevel: abilityLevel(row.shift, station.id),
      personAlreadyAssignedAtHour: personElsewhere,
      chicagoHour: chicagoHourOf(new Date(row.hourStartIso)),
    });

    for (const v of violations) {
      out.push({
        code: v.code,
        message: v.message,
        assignmentId: row.assignmentId,
        employeeName: `${row.shift.employee.firstName} ${row.shift.employee.lastName}`.trim(),
        stationId: station.id,
        hourLabel: chicagoHourLabel(row.hourStartIso),
      });
    }
  }

  return out;
}
