import type { DayBoardDto } from "@/components/board/types";
import { chicagoHourStart } from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";
import { screenOverlaysFromDto } from "@/lib/overlays/read";
import { isMainBoardPosition } from "./auxiliary";

/** Scheduled people, including unpainted work; one person per overlapping hour. */
export function scheduledHeadcounts(day: DayBoardDto | null, hours: readonly number[], now = new Date()): number[] {
  if (!day) return hours.map(() => 0);
  const removals = screenOverlaysFromDto(day.overlays ?? [], now)
    .filter(row => row.kind === "remove")
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return hours.map(hour => {
    const hourStart = chicagoHourStart(day.date, hour);
    const hourEnd = chicagoHourStart(day.date, hour + 1);
    const workers = day.shifts.filter(shift => {
      if (shift.date !== day.date || shift.board !== day.board || shift.supersededAt ||
          !isMainBoardPosition(shift.sourcePosition) ||
          !isHourInShift(hourStart, new Date(shift.startAt), new Date(shift.endAt))) return false;
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
