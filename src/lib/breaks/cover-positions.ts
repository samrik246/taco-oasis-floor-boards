import type { BreakCover, listBreakCovers } from "@/lib/breaks/covers";
import { buildDaySlices, sliceIndexesTouching, type SliceOverlay } from "@/lib/slices/day-slices";

export type CoverPositionInterval = {
  startAt: string;
  endAt: string;
  vacatedStationId: string | null;
  moves: { employeeId: string; firstName: string; fromStationId: string | null; toStationId: string | null }[];
};
export type ManagerBreakCover = BreakCover & { positions: CoverPositionInterval[] };

/** Manager-only explanation of the same effective before/after slices used by coverage. */
export function describeBreakCover(
  input: Parameters<typeof listBreakCovers>[0],
  cover: BreakCover,
  otherBoardOverlays: readonly SliceOverlay[] = [],
): ManagerBreakCover {
  const moves = cover.kind === "simple" ? [cover] : cover.moves;
  const resting = input.breaks.filter(row => row.employeeId !== input.employeeId);
  const base = { ...input, now: input.startAt, stations: input.starStationIds.map(id => ({ id })), breaks: resting, overlays: input.overlays ?? [] };
  const before = buildDaySlices(base);
  const other = buildDaySlices({ ...base, board: input.board === "caja" ? "cocina" : "caja", overlays: otherBoardOverlays });
  const shift = input.shifts.find(row => row.employeeId === input.employeeId && row.board === input.board
    && !row.superseded && !row.boardRemoved && row.startAt <= input.startAt && row.endAt >= input.endAt);
  if (!shift) return { ...cover, positions: [] };
  const after = buildDaySlices({ ...base, breaks: [...resting, {
    employeeId: input.employeeId, shiftId: shift.id, board: input.board,
    startAt: input.startAt, endAt: input.endAt, status: "booked",
    coverEmployeeId: moves[0].employeeId, shuffleEmployeeId: moves[1]?.employeeId,
  }] });
  const positions: CoverPositionInterval[] = [];
  for (const index of sliceIndexesTouching(before, input.startAt, input.endAt)) {
    const slice = before.slices[index];
    const interval: CoverPositionInterval = {
      startAt: slice.start.toISOString(), endAt: slice.end.toISOString(),
      vacatedStationId: slice.people.find(person => person.employeeId === input.employeeId)?.stationId ?? null,
      moves: moves.map(move => ({ employeeId: move.employeeId, firstName: move.firstName,
        fromStationId: slice.people.find(person => person.employeeId === move.employeeId)?.stationId
          ?? other.slices[index].people.find(person => person.employeeId === move.employeeId)?.stationId ?? null,
        toStationId: after.slices[index].people.find(person => person.employeeId === move.employeeId)?.stationId ?? null,
      })),
    };
    const previous = positions.at(-1);
    if (previous && previous.endAt === interval.startAt && previous.vacatedStationId === interval.vacatedStationId
      && JSON.stringify(previous.moves) === JSON.stringify(interval.moves)) previous.endAt = interval.endAt;
    else positions.push(interval);
  }
  return { ...cover, positions };
}
