import { boardWrite, acquireBoardWrite } from "@/lib/shared-write";
import { requireLegacy } from "@/lib/quarter/schema";
import { prisma } from "@/lib/db";
import { writeBoardChange, type BoardChangeActor } from "@/lib/board-change-log";
import { createShiftAssignment, type AssignmentTx } from "./service";

export type FixedAssignParams = {
  board: string;
  date: string;
  now?: Date;
  actor?: BoardChangeActor;
  /** When set, this write joins the caller's transaction instead of opening one. */
  db?: AssignmentTx;
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
 * something the ordinary assign flow would refuse. An occupied hour or a
 * person already painted that hour is skipped. Every import commit calls
 * `placeFixedForImportedDates` on the import transaction, for caja and
 * cocina; there is no button. The fixed-assign route omits `db` and opens
 * its own transaction.
 */
export async function placeFixedAssignments(
  params: FixedAssignParams,
): Promise<FixedAssignResult> {
  const run = async (tx: AssignmentTx): Promise<FixedAssignResult> => {
    await requireLegacy(tx);
    const maps = await tx.positionStationMap.findMany({
      where: { stationId: { not: null } },
      include: { station: true },
    });
    const byPosition = new Map(
      maps
        .filter((m) => m.station != null)
        .map((m) => [m.position, { stationId: m.stationId!, sortOrder: m.station!.sortOrder }]),
    );

    const shifts = await tx.shift.findMany({
      where: {
        date: params.date,
        board: params.board,
        supersededAt: null,
        boardRemoved: false,
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
        db: tx,
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

    if (params.actor) {
      await writeBoardChange(tx, params.actor, {
        date: params.date,
        count: summary.placed,
      });
    }
    return { ok: true as const, summary };
  };
  if (params.db) {await acquireBoardWrite(params.db);return run(params.db); }
  return boardWrite(prisma,run);
}

/**
 * Place fixed seats on each date for both boards.
 * Pass the import transaction so a throw rolls the schedule and fingerprint
 * back with the seats. Without `db`, each board opens its own transaction.
 */
export async function placeFixedForImportedDates(
  dates: readonly string[],
  db?: AssignmentTx,
): Promise<void> {
  for (const date of [...new Set(dates)]) {
    await placeFixedAssignments({ board: "caja", date, db });
    await placeFixedAssignments({ board: "cocina", date, db });
  }
}
