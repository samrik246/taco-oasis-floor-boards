import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
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
    breaks: (day.breaks ?? []).map((row) => ({
      employeeId: row.employeeId,
      shiftId: row.shiftId,
      board: day.board,
      startAt: new Date(row.startAt),
      endAt: new Date(row.endAt),
      status: "booked" as const,
      coverEmployeeId: null,
    })),
    overlays: [],
  };
  return buildDaySlices(input);
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
