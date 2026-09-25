import { prisma } from "@/lib/db";
import { createShiftAssignment } from "./service";

export type FixedAssignParams = {
  board: string;
  date: string;
  now?: Date;
};

export type FixedAssignSummary = {
  placed: number;
  alreadyThere: number;
  stationOccupied: number;
  personBusy: number;
  forbidden: number;
  superseded: number;
};

export type FixedAssignResult = { ok: true; summary: FixedAssignSummary };

/**
 * Planner G — "Colocar fijos". Places every non-superseded shift that day on
 * the open board whose When I Work position string has a mapped station
 * (`PositionStationMap`), ordered by the station's own sortOrder, then shift
 * start, then shift id. Every placement goes through `createShiftAssignment`
 * — the same whole-shift rules A already enforces, so fijos can never write
 * something the ordinary assign flow would refuse. Import never calls this;
 * it only runs when a manager taps the button for the open board and date.
 */
export async function placeFixedAssignments(
  params: FixedAssignParams,
): Promise<FixedAssignResult> {
  const maps = await prisma.positionStationMap.findMany({
    where: { stationId: { not: null } },
    include: { station: true },
  });
  const byPosition = new Map(
    maps
      .filter((m) => m.station != null)
      .map((m) => [m.position, { stationId: m.stationId!, sortOrder: m.station!.sortOrder }]),
  );

  const shifts = await prisma.shift.findMany({
    where: {
      date: params.date,
      board: params.board,
      supersededAt: null,
      sourcePosition: { in: [...byPosition.keys()] },
    },
  });

  const ordered = shifts
    .map((shift) => ({ shift, ...byPosition.get(shift.sourcePosition)! }))
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.shift.startAt.getTime() - b.shift.startAt.getTime() ||
        a.shift.id.localeCompare(b.shift.id),
    );

  const summary: FixedAssignSummary = {
    placed: 0,
    alreadyThere: 0,
    stationOccupied: 0,
    personBusy: 0,
    forbidden: 0,
    superseded: 0,
  };

  for (const { shift, stationId } of ordered) {
    const result = await createShiftAssignment({
      shiftId: shift.id,
      stationId,
      date: params.date,
      now: params.now,
    });
    if (result.ok) {
      summary.placed += result.summary.placed;
      summary.alreadyThere += result.summary.alreadyThere;
      summary.stationOccupied += result.summary.stationOccupied;
      summary.personBusy += result.summary.personBusy;
      summary.superseded += result.summary.superseded;
    } else if (result.violations.some((v) => v.code === "FORBIDDEN_ABILITY")) {
      summary.forbidden += 1;
    } else {
      // Board mismatch or another whole-shift-level refusal — rare (the map
      // stores a plain station id, not a board-checked one), folded into the
      // same "occupied" bucket the sentence already shows.
      summary.stationOccupied += 1;
    }
  }

  return { ok: true, summary };
}
