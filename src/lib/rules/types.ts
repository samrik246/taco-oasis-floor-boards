/** Domain rule types (SPEC §4) */

export type AbilityLevel = "forbidden" | "training" | "ok" | "preferred";

export const ABILITY_LEVELS: AbilityLevel[] = [
  "forbidden",
  "training",
  "ok",
  "preferred",
];

/** Machine-readable violation codes for 422 responses */
export type ViolationCode =
  | "OUT_OF_SHIFT"
  | "STATION_FULL"
  | "FORBIDDEN_ABILITY"
  | "PERSON_ALREADY_ASSIGNED"
  | "STATION_BOARD_MISMATCH"
  | "SHIFT_NOT_FOUND"
  | "STATION_NOT_FOUND"
  | "ASSIGNMENT_NOT_FOUND"
  | "INVALID_HOUR"
  | "SWAP_SAME_ASSIGNMENT";

export type RuleViolation = {
  code: ViolationCode;
  message: string;
};
