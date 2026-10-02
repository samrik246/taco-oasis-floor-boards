import type { DayBoardDto } from "@/components/board/types";
import { chicagoHourStart } from "@/lib/hour-grid";
import { screenOverlaysFromDto } from "@/lib/overlays/read";
import { isMainBoardPosition } from "./auxiliary";

/** Scheduled people, including unpainted work; one person per overlapping hour. */
export function scheduledHeadcounts(day: DayBoardDto | null, hours: readonly number[], now = new Date()): number[] {
  return scheduledIntervalHeadcounts(day, hours.map(hour => ({hour, minute: 0, minutes: 60})), now);
}

/** Count factual scheduled people, never paint rows or derived covers. */
export function scheduledIntervalHeadcounts(day: DayBoardDto | null, slots: readonly {hour: number; minute: number; minutes: number}[], now = new Date()): number[] {
  if (!day) return slots.map(() => 0);
  const removals = screenOverlaysFromDto(day.overlays ?? [], now)
    .filter(row => row.kind === "remove")
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return slots.map(({hour, minute, minutes}) => {
    const hourStart = new Date(+chicagoHourStart(day.date, hour) + minute * 60_000);
    const hourEnd = new Date(+hourStart + minutes * 60_000);
    const workers = day.shifts.filter(shift => {
      if (shift.date !== day.date || shift.board !== day.board || shift.supersededAt ||
          !isMainBoardPosition(shift.sourcePosition) ||
          Date.parse(shift.startAt) >= +hourEnd || Date.parse(shift.endAt) <= +hourStart) return false;
      let cursor = Math.max(hourStart.getTime(), new Date(shift.startAt).getTime());
      const end = Math.min(hourEnd.getTime(), new Date(shift.endAt).getTime());
      for (const row of removals) {
        if (row.employeeId !== shift.employee.id || row.endAt.getTime() <= cursor || row.startAt.getTime() >= end) continue;
        if (row.startAt.getTime() - cursor >= 60_000) return true;
        cursor = Math.max(cursor, row.endAt.getTime());
      }
      return end - cursor >= 60_000;
    });
    return new Set(workers.map(shift => shift.employee.id)).size;
  });
}
