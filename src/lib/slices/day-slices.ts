import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { HOUR_GRID_END, HOUR_GRID_START, TIMEZONE } from "@/lib/constants";

/** 7:00–10:00 Central, four slices an hour. Slice 0 is 7:00–7:15. Slice 59 is 9:45–10:00. */
export const SLICE_COUNT = (HOUR_GRID_END - HOUR_GRID_START) * 4;
const HOUR_MS = 60 * 60 * 1000;

export type SliceBoard = "caja" | "cocina";

export type SliceShift = {
  id: string;
  employeeId: string;
  board: string;
  startAt: Date;
  endAt: Date;
  superseded: boolean;
  boardRemoved: boolean;
};

export type SlicePaint = {
  employeeId: string;
  shiftId: string;
  stationId: string;
  hourStart: Date;
};

export type SliceBreak = {
  employeeId: string;
  shiftId: string;
  board: string;
  startAt: Date;
  endAt: Date;
  status: "booked" | "pending";
  coverEmployeeId?: string | null;
  /** Second Shuffle move. Takes the seat the cover left. */
  shuffleEmployeeId?: string | null;
  /** The five-minute pick named the cover. */
  auto?: boolean;
};

export type SliceOverlay = {
  id: string;
  kind: "switch" | "remove" | "add";
  employeeId: string;
  partnerEmployeeId?: string | null;
  stationId: string;
  fromStationId?: string | null;
  startAt: Date;
  endAt: Date;
  cancelledAt?: Date | null;
};

export type DaySliceInput = {
  date: string;
  board: SliceBoard;
  now: Date;
  stations: readonly { id: string }[];
  starStationIds: readonly string[];
  shifts: readonly SliceShift[];
  paints: readonly SlicePaint[];
  breaks: readonly SliceBreak[];
  overlays: readonly SliceOverlay[];
};

export type SliceCell = "absent" | "open" | "seated" | "break" | "move";

export type SlicePerson = {
  employeeId: string;
  /** On this board and not on a booked break, or seated here from another board. */
  counts: boolean;
  onBreak: boolean;
  stationId: string | null;
  /** Hourly paint, including slices the shift does not cover. */
  paintStationId: string | null;
  cell: SliceCell;
  /** This quarter is the seat an automatic cover moved into. */
  autoMove?: boolean;
};

export type SliceSeat = {
  stationId: string;
  employeeId: string;
  source: "paint" | "cover" | "overlay";
};

export type DaySlice = {
  index: number;
  start: Date;
  end: Date;
  people: SlicePerson[];
  seats: SliceSeat[];
  emptyStarStationIds: string[];
  presentNotOnBreak: number;
  bookedBreaks: number;
};

export type DaySlices = {
  starCount: number;
  slices: DaySlice[];
};

export type QuarterKind = "off" | "open" | "seated" | "break";

export type QuarterView = {
  kind: QuarterKind;
  label: string;
  /** The moved quarter of an automatic cover. */
  auto?: boolean;
};

/** Wall-clock start of slice `index`. Index 60 is 10:00, the end of the last slice. */
export function sliceStart(date: string, index: number): Date {
  const minutes = HOUR_GRID_START * 60 + index * 15;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return fromZonedTime(`${date}T${hh}:${mm}:00`, TIMEZONE);
}

export function sliceClockLabel(instant: Date): string {
  return formatInTimeZone(instant, TIMEZONE, "h:mm");
}

export function hourSliceIndexes(hour: number): number[] {
  const base = (hour - HOUR_GRID_START) * 4;
  return [base, base + 1, base + 2, base + 3];
}

function windowCovers(start: Date, end: Date, sliceStartAt: Date, sliceEndAt: Date): boolean {
  return sliceStartAt.getTime() >= start.getTime() && sliceEndAt.getTime() <= end.getTime();
}

/** Paint on one of these shifts for this person and hour. Superseded rows are not in the set. */
function paintOnShifts(
  paints: readonly SlicePaint[],
  employeeId: string,
  shiftIds: ReadonlySet<string>,
  at: Date,
): string | null {
  if (shiftIds.size === 0) return null;
  const t = at.getTime();
  for (const paint of paints) {
    if (paint.employeeId !== employeeId || !shiftIds.has(paint.shiftId)) continue;
    const start = paint.hourStart.getTime();
    if (t >= start && t < start + HOUR_MS) return paint.stationId;
  }
  return null;
}

function liveCovering(shifts: readonly SliceShift[], start: Date, end: Date): SliceShift[] {
  return shifts.filter((shift) => {
    return !shift.superseded
      && !shift.boardRemoved
      && windowCovers(shift.startAt, shift.endAt, start, end);
  });
}

/**
 * One pass over the 60 slices. No database.
 * A slice counts only when the shift covers it entirely.
 * Paint fills a seat only when that paint's shift is the live shift covering the slice.
 * A live shift's paint still marks the rest of its hour open. A superseded shift's paint does not.
 * Booked breaks beat paint. A named cover fills that seat.
 * A Shuffle's second person fills the star seat that cover left.
 * An overlay beats paint. A pending break places nobody.
 * `now` is accepted so a later rest-of-shift read uses the same input.
 */
export function buildDaySlices(input: DaySliceInput): DaySlices {
  const starStationIds = [...new Set(input.starStationIds)];
  const ids = new Set<string>();
  for (const shift of input.shifts) ids.add(shift.employeeId);
  for (const row of input.breaks) {
    ids.add(row.employeeId);
    if (row.coverEmployeeId) ids.add(row.coverEmployeeId);
    if (row.shuffleEmployeeId) ids.add(row.shuffleEmployeeId);
  }
  for (const row of input.overlays) {
    ids.add(row.employeeId);
    if (row.partnerEmployeeId) ids.add(row.partnerEmployeeId);
  }
  for (const paint of input.paints) ids.add(paint.employeeId);

  const liveShiftIds = new Map<string, Set<string>>();
  for (const shift of input.shifts) {
    if (shift.superseded || shift.boardRemoved) continue;
    const held = liveShiftIds.get(shift.employeeId) ?? new Set<string>();
    held.add(shift.id);
    liveShiftIds.set(shift.employeeId, held);
  }

  const slices: DaySlice[] = [];
  for (let index = 0; index < SLICE_COUNT; index += 1) {
    const start = sliceStart(input.date, index);
    const end = sliceStart(input.date, index + 1);
    const live = liveCovering(input.shifts, start, end);
    const people: SlicePerson[] = [];
    const seats = new Map<string, SliceSeat>();

    for (const employeeId of ids) {
      const mine = live.filter((shift) => shift.employeeId === employeeId);
      const onThisBoard = mine.some((shift) => shift.board === input.board);
      const shiftCovers = mine.length > 0;
      const coveringIds = new Set(mine.map((shift) => shift.id));
      const coveringPaint = paintOnShifts(input.paints, employeeId, coveringIds, start);
      const paintStationId = coveringPaint
        ?? paintOnShifts(input.paints, employeeId, liveShiftIds.get(employeeId) ?? coveringIds, start);
      const booked = input.breaks.find((row) => {
        return row.status === "booked"
          && row.employeeId === employeeId
          && row.board === input.board
          && windowCovers(row.startAt, row.endAt, start, end);
      });
      const overlay = input.overlays.find((row) => {
        return !row.cancelledAt
          && windowCovers(row.startAt, row.endAt, start, end)
          && (row.employeeId === employeeId || row.partnerEmployeeId === employeeId);
      });

      let cell: SliceCell = "absent";
      let stationId: string | null = null;
      let source: SliceSeat["source"] | null = null;
      let counts = false;
      let onBreak = false;

      if (onThisBoard && booked) {
        cell = "break";
        onBreak = true;
      } else if (overlay?.kind === "remove" && overlay.employeeId === employeeId && onThisBoard) {
        cell = "open";
        counts = true;
      } else if (overlay?.kind === "switch" && overlay.employeeId === employeeId && shiftCovers) {
        cell = "move";
        stationId = overlay.stationId;
        source = "overlay";
        counts = true;
      } else if (
        overlay?.kind === "switch"
        && overlay.partnerEmployeeId === employeeId
        && overlay.fromStationId
        && shiftCovers
      ) {
        cell = "move";
        stationId = overlay.fromStationId;
        source = "overlay";
        counts = true;
      } else if (overlay?.kind === "add" && overlay.partnerEmployeeId === employeeId && shiftCovers) {
        cell = "move";
        stationId = overlay.stationId;
        source = "overlay";
        counts = true;
      } else if (onThisBoard && coveringPaint) {
        cell = "seated";
        stationId = coveringPaint;
        source = "paint";
        counts = true;
      } else if (onThisBoard) {
        cell = "open";
        counts = true;
      }

      if (cell === "absent" && !paintStationId) continue;
      people.push({ employeeId, counts, onBreak, stationId, paintStationId, cell });
      if (stationId && source) seats.set(stationId, { stationId, employeeId, source });
    }

    for (const row of input.breaks) {
      if (row.status !== "booked" || row.board !== input.board || !row.coverEmployeeId) continue;
      if (!windowCovers(row.startAt, row.endAt, start, end)) continue;
      const breakerIds = new Set(
        live.filter((shift) => shift.employeeId === row.employeeId).map((shift) => shift.id),
      );
      const stationId = paintOnShifts(input.paints, row.employeeId, breakerIds, start);
      if (!stationId) continue;
      if (!live.some((shift) => shift.employeeId === row.coverEmployeeId)) continue;
      let vacatedStation: string | null = null;
      for (const [seatId, seat] of [...seats]) {
        if (seat.employeeId !== row.coverEmployeeId) continue;
        vacatedStation = seatId;
        seats.delete(seatId);
      }
      seats.set(stationId, { stationId, employeeId: row.coverEmployeeId, source: "cover" });
      const cover = people.find((person) => person.employeeId === row.coverEmployeeId);
      if (cover) {
        cover.cell = "move";
        cover.stationId = stationId;
        cover.counts = true;
        cover.onBreak = false;
        if (row.auto) cover.autoMove = true;
      } else {
        people.push({
          employeeId: row.coverEmployeeId,
          counts: true,
          onBreak: false,
          stationId,
          paintStationId: paintOnShifts(
            input.paints,
            row.coverEmployeeId,
            liveShiftIds.get(row.coverEmployeeId) ?? new Set<string>(),
            start,
          ),
          cell: "move",
          ...(row.auto ? { autoMove: true } : {}),
        });
      }
      if (!row.shuffleEmployeeId || !vacatedStation || vacatedStation === stationId) continue;
      if (!live.some((shift) => shift.employeeId === row.shuffleEmployeeId)) continue;
      for (const [seatId, seat] of [...seats]) {
        if (seat.employeeId === row.shuffleEmployeeId) seats.delete(seatId);
      }
      seats.set(vacatedStation, { stationId: vacatedStation, employeeId: row.shuffleEmployeeId, source: "cover" });
      const partner = people.find((person) => person.employeeId === row.shuffleEmployeeId);
      if (partner) {
        partner.cell = "move";
        partner.stationId = vacatedStation;
        partner.counts = true;
        partner.onBreak = false;
      } else {
        people.push({
          employeeId: row.shuffleEmployeeId,
          counts: true,
          onBreak: false,
          stationId: vacatedStation,
          paintStationId: paintOnShifts(
            input.paints,
            row.shuffleEmployeeId,
            liveShiftIds.get(row.shuffleEmployeeId) ?? new Set<string>(),
            start,
          ),
          cell: "move",
        });
      }
    }

    const present = new Set(people.filter((person) => person.counts).map((person) => person.employeeId));
    slices.push({
      index,
      start,
      end,
      people,
      seats: [...seats.values()],
      emptyStarStationIds: starStationIds.filter((id) => !seats.has(id)),
      presentNotOnBreak: present.size,
      bookedBreaks: input.breaks.filter((row) => {
        return row.status === "booked"
          && row.board === input.board
          && windowCovers(row.startAt, row.endAt, start, end);
      }).length,
    });
  }

  return { starCount: starStationIds.length, slices };
}

/** The four quarters of one grid hour, for the cells. */
export function personQuarters(day: DaySlices, employeeId: string, hour: number): QuarterView[] {
  return hourSliceIndexes(hour).map((index) => {
    const slice = day.slices[index];
    const label = slice ? sliceClockLabel(slice.start) : "";
    const person = slice?.people.find((row) => row.employeeId === employeeId);
    if (!person) return { kind: "off", label };
    if (person.cell === "break") return { kind: "break", label };
    if (person.cell === "seated" || person.cell === "move") {
      return person.autoMove ? { kind: "seated", label, auto: true } : { kind: "seated", label };
    }
    if (person.cell === "open") return { kind: "open", label };
    if (person.paintStationId) return { kind: "open", label };
    return { kind: "off", label };
  });
}

/**
 * Open quarters of a station-hour that is seated for part of the hour.
 * A fully empty hour stays the station's empty control, with no clock labels.
 */
export function stationOpenQuarters(day: DaySlices, stationId: string, hour: number): QuarterView[] {
  const quarters = hourSliceIndexes(hour).map((index) => {
    const slice = day.slices[index];
    const taken = slice?.seats.some((seat) => seat.stationId === stationId) ?? false;
    return { kind: taken ? "seated" as const : "open" as const, label: slice ? sliceClockLabel(slice.start) : "" };
  });
  if (!quarters.some((quarter) => quarter.kind === "seated")) return [];
  return quarters.filter((quarter) => quarter.kind === "open");
}

export function sliceIndexesTouching(day: DaySlices, start: Date, end: Date): number[] {
  return day.slices
    .filter((slice) => slice.start.getTime() < end.getTime() && start.getTime() < slice.end.getTime())
    .map((slice) => slice.index);
}
