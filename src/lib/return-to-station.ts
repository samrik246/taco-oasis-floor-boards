/**
 * Return-to-station: when a load station is Slammed and the assignee (or MULTI)
 * is on a working tarea → auto-unassign + prompt.
 */

import type { BusynessLevel } from "@/lib/load-stations";
import {
  CASHIER_LOAD_STATIONS,
  loadStationForSeat,
  type LoadStationId,
} from "@/lib/load-stations";

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
  loadStationId: LoadStationId;
  seatId: string;
  tareaIds: string[];
  message: string;
};

/**
 * Who should be prompted back when a load station is slammed:
 * - Anyone currently seated on that load station's seats who has working tareas
 * - Anyone on MULTI (floater) who has working tareas (helps everywhere)
 */
export function draftReturnPrompts(args: {
  meters: { loadStationId: LoadStationId; level: BusynessLevel }[];
  seatAssignees: SeatAssignee[];
  workingTareas: ActiveTareaRef[];
}): ReturnPromptDraft[] {
  const slammed = new Set(
    args.meters.filter((m) => m.level === "slammed").map((m) => m.loadStationId),
  );
  if (slammed.size === 0) return [];

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

    const onMulti = assignee.seatId === "multi";
    const load = loadStationForSeat(assignee.seatId);
    const relevantLoad = onMulti
      ? [...slammed][0]
      : load && slammed.has(load.id)
        ? load.id
        : null;

    if (!relevantLoad && !onMulti) continue;
    if (onMulti && slammed.size === 0) continue;

    const loadId: LoadStationId = onMulti
      ? ([...slammed][0] as LoadStationId)
      : (relevantLoad as LoadStationId);

    if (!slammed.has(loadId) && !onMulti) continue;
    if (onMulti && !slammed.has(loadId)) {
      // MULTI: prompt for any slammed station
    }

    const key = `${assignee.employeeId}:${loadId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const loadLabel =
      CASHIER_LOAD_STATIONS.find((s) => s.id === loadId)?.label ?? loadId;

    drafts.push({
      employeeId: assignee.employeeId,
      displayName: assignee.displayName,
      loadStationId: loadId,
      seatId: assignee.seatId,
      tareaIds: tareas.map((t) => t.id),
      message: onMulti
        ? `${assignee.displayName} (MULTI): ${loadLabel} is Slammed — return to help; tareas unassigned.`
        : `${assignee.displayName}: ${loadLabel} is Slammed — return to ${assignee.seatId}; tareas unassigned.`,
    });
  }

  return drafts;
}
