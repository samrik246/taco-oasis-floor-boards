import type { DayBoardDto } from "@/components/board/types";
import { chicagoHourStart } from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";
import { removedHours } from "@/lib/overlays/read";
import { isMainBoardPosition } from "./auxiliary";

/** Scheduled people, including unpainted work; one person per overlapping hour. */
export function scheduledHeadcounts(day: DayBoardDto | null, hours: readonly number[], now = new Date()): number[] {
  return hours.map(hour => new Set((day?.shifts ?? []).filter(shift =>
    day && shift.date === day.date && shift.board === day.board && !shift.supersededAt &&
    isMainBoardPosition(shift.sourcePosition) &&
    isHourInShift(chicagoHourStart(day.date, hour), new Date(shift.startAt), new Date(shift.endAt)) &&
    !removedHours(day.overlays ?? [], shift.employee.id, day.date, now).has(hour),
  ).map(shift => shift.employee.id)).size);
}
