import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
import { screenOverlaysFromDto } from "@/lib/overlays/read";
import { chicagoYmd } from "@/lib/schedule/build-schedule";
import { buildDaySlices, type DaySliceInput, type DaySlices, type SlicePaint } from "@/lib/slices/day-slices";
import { amberEmptyShiftHours } from "@/lib/slices/paint-ratio";
import type { DayBoardDto } from "./types";

export type SliceDraft = {
  shiftId: string;
  hour: number;
  stationId: string | null;
};

/** Saved rows, with a paint draft replacing that shift-hour. */
export function slicesForDay(day: DayBoardDto, now: Date, drafts: readonly SliceDraft[] = []): DaySlices {
  const draftKey = new Map(drafts.map((draft) => [`${draft.shiftId}|${draft.hour}`, draft.stationId]));
  const paints: SlicePaint[] = [];
  for (const shift of day.shifts) {
    const hours = new Map<number, string>();
    for (const assignment of shift.assignments) {
      hours.set(chicagoHourOf(new Date(assignment.hourStart)), assignment.stationId);
    }
    for (const [key, stationId] of draftKey) {
      const [shiftId, hourText] = key.split("|");
      if (shiftId !== shift.id || stationId == null) continue;
      hours.set(Number(hourText), stationId);
    }
    for (const [key, stationId] of draftKey) {
      const [shiftId, hourText] = key.split("|");
      if (shiftId !== shift.id || stationId != null) continue;
      hours.delete(Number(hourText));
    }
    for (const [hour, stationId] of hours) {
      paints.push({
        employeeId: shift.employee.id,
        shiftId: shift.id,
        stationId,
        hourStart: chicagoHourStart(day.date, hour),
      });
    }
  }
  const input: DaySliceInput = {
    date: day.date,
    board: day.board,
    now,
    stations: day.stations.map((station) => ({ id: station.id })),
    starStationIds: day.mandatory?.stationIds ?? [...MANDATORY_STATIONS_BY_BOARD[day.board]],
    shifts: day.shifts.map((shift) => ({
      id: shift.id,
      employeeId: shift.employee.id,
      board: shift.board,
      startAt: new Date(shift.startAt),
      endAt: new Date(shift.endAt),
      superseded: Boolean(shift.supersededAt),
      boardRemoved: false,
    })),
    paints,
    breaks: (day.breaks ?? []).filter(row => !day.coverDisplay || day.coverDisplay.tracks.some(track => track.shiftId === row.shiftId
      && track.employeeId === row.employeeId && track.segments.some(s => s.kind === "break"))).map((row) => ({
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      board: day.board,
      startAt: new Date(row.startAt),
      endAt: new Date(row.endAt),
      status: "booked" as const,
      // Saved movement is applied below only from exact validated persisted evidence.
      coverEmployeeId: null,
      auto: row.auto === true,
    })),
    overlays: screenOverlaysFromDto(day.overlays ?? [], now),
  };
  const result = buildDaySlices(input);
  for (const slice of result.slices) {
    for (const track of day.coverDisplay?.tracks ?? []) {
      const segment = track.segments.find(s => s.kind !== "work" && Date.parse(s.startAt) <= +slice.start && Date.parse(s.endAt) >= +slice.end);
      if (!segment) continue;
      slice.seats = slice.seats.filter(s => s.employeeId !== track.employeeId);
      const arrives = segment.kind === "cover" && segment.station?.board === day.board;
      const onBreak = segment.kind === "break" && track.board === day.board;
      const person = slice.people.find(p => p.employeeId === track.employeeId);
      const change = { counts: Boolean(arrives), onBreak, stationId: arrives ? segment.station!.id : null,
        cell: onBreak ? "break" as const : arrives ? "move" as const : "absent" as const, autoMove: arrives && segment.auto };
      if (person) Object.assign(person, change);
      else if (arrives || onBreak) slice.people.push({ employeeId: track.employeeId, paintStationId: null, ...change });
      if (arrives) {
        slice.seats = slice.seats.filter(s => s.stationId !== segment.station!.id);
        slice.seats.push({ stationId: segment.station!.id, employeeId: track.employeeId, source: "cover" });
      }
    }
    slice.emptyStarStationIds = input.starStationIds.filter(id => !slice.seats.some(s => s.stationId === id));
    slice.presentNotOnBreak = new Set(slice.people.filter(p => p.counts).map(p => p.employeeId)).size;
  }
  return result;
}

/** Empty on-shift hours that take the amber mark. Saved paint only, and only today. */
export function amberHoursForDay(day: DayBoardDto, now: Date): Map<string, Set<number>> {
  const marks = amberEmptyShiftHours({
    date: day.date,
    today: chicagoYmd(now),
    board: day.board,
    shifts: day.shifts.map((shift) => ({
      id: shift.id,
      employeeId: shift.employee.id,
      board: shift.board,
      startAt: new Date(shift.startAt),
      endAt: new Date(shift.endAt),
      superseded: Boolean(shift.supersededAt),
      boardRemoved: false,
    })),
    paints: day.shifts.flatMap((shift) => shift.assignments.map((assignment) => ({
      employeeId: shift.employee.id,
      shiftId: shift.id,
      stationId: assignment.stationId,
      hourStart: new Date(assignment.hourStart),
    }))),
  });
  return new Map([...marks].map(([shiftId, hours]) => [shiftId, new Set(hours)]));
}
