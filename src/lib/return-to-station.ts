/**
 * Return-to-station: when a load station is Spammed/Slammed and the assignee
 * (or floater seats like MULTI) is on a working tarea → auto-unassign + prompt.
 * Board-aware via load maps + floaterSeatIds from board-config.
 */

import type { BusynessLevel } from "@/lib/load-stations";
import {
  allLoadStationDefs,
  loadStationForSeat,
} from "@/lib/load-stations";
import {
  BOARD_CONFIGS,
  type FloorBoardId,
} from "@/lib/board-config";

export type ActiveTareaRef = {
  id: string;
  employeeId: string;
  templateLabel: string;
};

export type SeatAssignee = {
  employeeId: string;
  seatId: string;
  displayName: string;
};

export type ReturnPromptDraft = {
  employeeId: string;
  displayName: string;
  loadStationId: string;
  seatId: string;
  tareaIds: string[];
  message: string;
};

function floaterSeatIdsFor(seatId: string): boolean {
  return Object.values(BOARD_CONFIGS).some((c) =>
    c.rules.floaterSeatIds.includes(seatId),
  );
}

/**
 * Who should be prompted back when a load station is slammed:
 * - Anyone currently seated on that load station's seats who has working tareas
 * - Anyone on a floater seat (e.g. MULTI) who has working tareas
 */
export function draftReturnPrompts(args: {
  meters: { loadStationId: string; level: BusynessLevel }[];
  seatAssignees: SeatAssignee[];
  workingTareas: ActiveTareaRef[];
  /** Optional: only consider floater rules for this board */
  board?: FloorBoardId;
}): ReturnPromptDraft[] {
  const slammed = new Set(
    args.meters.filter((m) => m.level === "slammed").map((m) => m.loadStationId),
  );
  if (slammed.size === 0) return [];

  const floaterIds = args.board
    ? new Set(BOARD_CONFIGS[args.board].rules.floaterSeatIds)
    : new Set(
        Object.values(BOARD_CONFIGS).flatMap((c) => [...c.rules.floaterSeatIds]),
      );

  const tareasByEmployee = new Map<string, ActiveTareaRef[]>();
  for (const t of args.workingTareas) {
    const list = tareasByEmployee.get(t.employeeId) ?? [];
    list.push(t);
    tareasByEmployee.set(t.employeeId, list);
  }

  const drafts: ReturnPromptDraft[] = [];
  const seen = new Set<string>();

  for (const assignee of args.seatAssignees) {
    const tareas = tareasByEmployee.get(assignee.employeeId);
    if (!tareas || tareas.length === 0) continue;

    const onFloater =
      floaterIds.has(assignee.seatId) || floaterSeatIdsFor(assignee.seatId);
    const load = loadStationForSeat(assignee.seatId);
    const relevantLoad = onFloater
      ? [...slammed][0]
      : load && slammed.has(load.id)
        ? load.id
        : null;

    if (!relevantLoad && !onFloater) continue;
    if (onFloater && slammed.size === 0) continue;

    const loadId = onFloater ? ([...slammed][0] as string) : (relevantLoad as string);

    if (!slammed.has(loadId) && !onFloater) continue;

    const key = `${assignee.employeeId}:${loadId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const loadLabel =
      allLoadStationDefs().find((s) => s.id === loadId)?.label ?? loadId;

    drafts.push({
      employeeId: assignee.employeeId,
      displayName: assignee.displayName,
      loadStationId: loadId,
      seatId: assignee.seatId,
      tareaIds: tareas.map((t) => t.id),
      message: onFloater
        ? `${assignee.displayName} (floater): ${loadLabel} is Slammed — return to help; tareas unassigned.`
        : `${assignee.displayName}: ${loadLabel} is Slammed — return to ${assignee.seatId}; tareas unassigned.`,
    });
  }

  return drafts;
}
