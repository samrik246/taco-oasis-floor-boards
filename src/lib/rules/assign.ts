import { isHourInShift } from "./shift-window";
import { canOccupyStation } from "./uniqueness";
import { isAbilityBlocking } from "./abilities";
import type { AbilityLevel, RuleViolation } from "./types";
import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";

export type ValidateAssignInput = {
  hourStart: Date;
  /** End of the grid hour; defaults to hourStart + 1 h. */
  hourEnd?: Date;
  shiftStart: Date;
  shiftEnd: Date;
  stationId: string;
  stationBoard: string;
  shiftBoard: string;
  maxConcurrent: number;
  /** Current occupancy at station+hour (including self if updating) */
  existingOccupancy: number;
  /** True when this assign updates an existing row already counted in occupancy */
  updatingExistingOnStation?: boolean;
  abilityLevel: AbilityLevel | null;
  /** Whether this employee already has another assignment at this hour */
  personAlreadyAssignedAtHour: boolean;
  /** Chicago wall-clock hour 0–23 for grid check */
  chicagoHour: number;
};

/**
 * Pure validation for creating/updating an assignment.
 * Returns empty array if valid; otherwise machine-readable violations.
 */
export function validateAssignment(
  input: ValidateAssignInput,
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  if (
    input.chicagoHour < HOUR_GRID_START ||
    input.chicagoHour >= HOUR_GRID_END
  ) {
    violations.push({
      code: "INVALID_HOUR",
      message: `Hour ${input.chicagoHour} is outside the ${HOUR_GRID_START}–${HOUR_GRID_END} grid`,
    });
  }

  if (input.stationBoard !== input.shiftBoard) {
    violations.push({
      code: "STATION_BOARD_MISMATCH",
      message: `Station ${input.stationId} is on ${input.stationBoard} but shift is ${input.shiftBoard}`,
    });
  }

  if (!isHourInShift(input.hourStart, input.shiftStart, input.shiftEnd, input.hourEnd)) {
    violations.push({
      code: "OUT_OF_SHIFT",
      message: "Hour is outside the employee's shift window",
    });
  }

  if (
    !canOccupyStation({
      maxConcurrent: input.maxConcurrent,
      existingOccupancy: input.existingOccupancy,
      reservingSlot: input.updatingExistingOnStation === true,
    })
  ) {
    violations.push({
      code: "STATION_FULL",
      message: `Station ${input.stationId} already has max concurrent occupants`,
    });
  }

  if (isAbilityBlocking(input.abilityLevel)) {
    violations.push({
      code: "FORBIDDEN_ABILITY",
      message: `Employee is forbidden from station ${input.stationId}`,
    });
  }

  if (input.personAlreadyAssignedAtHour) {
    violations.push({
      code: "PERSON_ALREADY_ASSIGNED",
      message: "Employee is already assigned to a station at this hour",
    });
  }

  return violations;
}
