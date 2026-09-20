/** Reasons required when moving someone off their station (Phase 1). */

export const MOVE_REASONS = [
  "Break",
  "Cover expo",
  "Training",
  "Help slammed",
  "Other",
] as const;

export type MoveReason = (typeof MOVE_REASONS)[number];

export function isValidMoveReason(reason: string): reason is MoveReason {
  return (MOVE_REASONS as readonly string[]).includes(reason);
}
