import { levelWhenUnset } from "@/lib/abilities/column-default";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { nievesSeats, type FixedWindow } from "@/lib/import/nieves";
import type { QuarterDb } from "./schema";
import { assignedIntervals, overlaps, type PaintHour, type PaintWorld } from "./world";

/** Stage only genuinely new source minutes; caller validates and persists atomically. */
export async function proposeNievesHour(db: QuarterDb, world: PaintWorld, hour: PaintHour,
  windows: readonly FixedWindow[], mappedStationId: string) {
  const seats = nievesSeats(mappedStationId);
  const [abilities, defaults, breaks, overlays] = await Promise.all([
    db.employeeStationAbility.findMany({ where: { employeeId: hour.employeeId } }),
    loadColumnDefaults(db),
    db.staffBreak.findMany({ where: { date: hour.date, status: "booked",
      OR: [{ employeeId: hour.employeeId }, { coverEmployeeId: hour.employeeId }, { shuffleEmployeeId: hour.employeeId }] } }),
    db.boardOverlay.findMany({ where: { date: hour.date, cancelledAt: null,
      OR: [{ employeeId: hour.employeeId }, { partnerEmployeeId: hour.employeeId }] } }),
  ]);
  const protectedWork = [...breaks, ...overlays].map(o => ({ startMs: +o.startAt, endMs: +o.endAt }));
  const occupied = assignedIntervals(world);
  const eligible = seats.filter(id => world.stations.some(s => s.id === id && s.board === hour.board)
    && levelWhenUnset(abilities.find(a => a.stationId === id)?.level, defaults.get(id)) !== "forbidden");
  const prior = occupied.filter(s => s.shiftId === hour.shiftId && seats.includes(s.stationId!) && s.endMs <= hour.hourStartMs)
    .sort((a, b) => b.endMs - a.endMs)[0];
  let preferred = prior?.stationId ?? mappedStationId;
  const placed: FixedWindow[] = [], skipped: (FixedWindow & { reason: string })[] = [];
  hour.segments = hour.segments.flatMap(segment => {
    if (segment.state !== "erased" || !windows.some(w => overlaps(w, segment))) return [segment];
    const bounds = [...new Set([segment.startMs, segment.endMs, ...[...windows, ...occupied, ...protectedWork]
      .flatMap(w => [w.startMs, w.endMs]).filter(t => t > segment.startMs && t < segment.endMs)])].sort((a, b) => a - b);
    return bounds.slice(1).map((endMs, index) => {
      const startMs = bounds[index], part = { ...segment, id: `fixed:${hour.shiftId}:${startMs}`, startMs, endMs };
      if (!windows.some(w => w.startMs <= startMs && w.endMs >= endMs)) return part;
      let reason = protectedWork.some(w => overlaps(w, part)) ? "SAVED_OBLIGATION"
        : occupied.some(s => s.shiftId !== hour.shiftId && s.employeeId === hour.employeeId && overlaps(s, part)) ? "PERSON_ALREADY_ASSIGNED" : null;
      const stationId = reason ? undefined : [preferred, ...eligible.filter(id => id !== preferred)].find(id => {
        if (!eligible.includes(id)) return false;
        const station = world.stations.find(s => s.id === id)!;
        return station.maxConcurrent < 0 || occupied.filter(s => s.stationId === id && overlaps(s, part)).length < station.maxConcurrent;
      });
      if (stationId) {
        preferred = stationId; placed.push({ startMs, endMs });
        return { ...part, state: "assigned" as const, stationId, seatNumber: null };
      }
      reason ??= "NO_ELIGIBLE_FREE_SEAT";
      skipped.push({ startMs, endMs, reason });
      return part;
    });
  });
  return { placed, skipped };
}
