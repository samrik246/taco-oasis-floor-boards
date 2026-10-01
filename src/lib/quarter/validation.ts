import { familyForStation } from "@/lib/assignments/paint-families";
import { familySeatIndex, lowestFreeSeatNumber } from "@/lib/assignments/seat-number";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { QuarterRefused, type QuarterDb } from "./schema";
import { assignedIntervals, assertPartition, hourKey, overlaps, type PaintWorld, type PaintHour } from "./world";

/** Infer legacy null seats once, respecting actual overlap. Persisted numbers always win. */
export function projectSeatNumbers(world: PaintWorld): void {
  const assigned = world.hours.flatMap(h => h.segments.filter(s => s.state === "assigned").map(s => ({ h,s })));
  assigned.sort((a,b) => (a.s.seatNumber === null ? 1:0) - (b.s.seatNumber === null ? 1:0) ||
    familySeatIndex(a.s.stationId!) - familySeatIndex(b.s.stationId!) || (a.s.assignmentId ?? a.s.id).localeCompare(b.s.assignmentId ?? b.s.id) || a.s.startMs-b.s.startMs);
  const processed: typeof assigned = [];
  for (const row of assigned) {
    const family = familyForStation(row.s.stationId!);
    if (!family) continue;
    const peers = processed.filter(p => p.h.hourStartMs === row.h.hourStartMs && familyForStation(p.s.stationId!) === family && overlaps(p.s,row.s) && p.h.employeeId !== row.h.employeeId);
    const used = peers.map(p => p.s.seatNumber!);
    if (row.s.seatNumber !== null && used.includes(row.s.seatNumber)) throw new QuarterRefused("SEAT_NUMBER_CONFLICT");
    if (row.s.seatNumber === null) {
      const previous = processed.find(p => p.h === row.h && familyForStation(p.s.stationId!) === family && p.s.endMs <= row.s.startMs)?.s.seatNumber;
      row.s.seatNumber = previous && !used.includes(previous) ? previous : lowestFreeSeatNumber(used);
    }
    processed.push(row);
  }
}

/** Complete peer closure uses the pre-edit world; adoption never backfills Assignment. */
export function peerHours(world: PaintWorld, touched: Set<string>, targets: { hourStartMs:number; stationId:string }[]): PaintHour[] {
  const families = new Set(targets.flatMap(t => { const f = familyForStation(t.stationId); return f ? [`${t.hourStartMs}|${f}`] : []; }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of world.hours) {
      const key = hourKey(h.shiftId,h.hourStartMs);
      const groups = h.segments.flatMap(s => { const f = s.stationId && familyForStation(s.stationId); return f ? [`${h.hourStartMs}|${f}`] : []; });
      if (touched.has(key) || groups.some(g => families.has(g))) {
        if (!touched.has(key)) { touched.add(key); changed = true; }
        for (const g of groups) if (!families.has(g)) { families.add(g); changed = true; }
      }
    }
  }
  if (touched.size > 500) throw new QuarterRefused("TOO_MANY_HOURS",422);
  return world.hours.filter(h => touched.has(hourKey(h.shiftId,h.hourStartMs)));
}

export async function validatePaintWorld(db: QuarterDb, world: PaintWorld, touched: Set<string>): Promise<void> {
  const sources = new Map(world.sources.map(s => [s.id,s]));
  for (const h of world.hours) assertPartition(h,sources.get(h.shiftId)!);
  const intervals = assignedIntervals(world);
  const abilities = await db.employeeStationAbility.findMany({ where:{ employeeId:{ in:[...new Set(intervals.map(s => s.employeeId))] } } });
  const defaults = await loadColumnDefaults(db);
  const levels = new Map(abilities.map(a => [`${a.employeeId}|${a.stationId}`,a.level]));
  for (const h of world.hours.filter(h => touched.has(hourKey(h.shiftId,h.hourStartMs)))) {
    for (const s of h.segments.filter(s => s.state === "assigned")) {
      const station = world.stations.find(st => st.id === s.stationId);
      if (!station || station.board !== h.board) throw new QuarterRefused("STATION_BOARD_MISMATCH",422);
      if (levelWhenUnset(levels.get(`${h.employeeId}|${s.stationId}`),defaults.get(s.stationId!)) === "forbidden") throw new QuarterRefused("FORBIDDEN_ABILITY",422);
      const others = intervals.filter(p => p.shiftId !== h.shiftId && overlaps(p,s));
      if (others.some(p => p.employeeId === h.employeeId)) throw new QuarterRefused("PERSON_ALREADY_ASSIGNED",422);
      const bounds = [...new Set([s.startMs,...others.filter(p => p.stationId === s.stationId).map(p => Math.max(p.startMs,s.startMs))])];
      if (station.maxConcurrent >= 0 && bounds.some(t => 1 + others.filter(p => p.stationId === s.stationId && p.startMs <= t && p.endMs > t).length > station.maxConcurrent))
        throw new QuarterRefused("STATION_FULL",422);
    }
  }
}

/** Protect persisted obligations from an unrequested move; callers can edit the free remainder. */
export async function validateObligations(db: QuarterDb, before: PaintWorld, after: PaintWorld, now: Date): Promise<void> {
  const bookings = await db.staffBreak.findMany({ where:{ date:before.date, status:"booked", endAt:{ gt:now } },
    select:{ employeeId:true,coverEmployeeId:true,shuffleEmployeeId:true,startAt:true,endAt:true } });
  const overlays = await db.boardOverlay.findMany({ where:{ date:before.date,cancelledAt:null,endAt:{ gt:now } },
    select:{ employeeId:true,partnerEmployeeId:true,startAt:true,endAt:true } });
  const obligations = [...bookings.map(b => ({ people:[b.employeeId,b.coverEmployeeId,b.shuffleEmployeeId],startMs:+b.startAt,endMs:+b.endAt,code:"PERSISTED_COVER_CONFLICT" })),
    ...overlays.map(o => ({ people:[o.employeeId,o.partnerEmployeeId],startMs:+o.startAt,endMs:+o.endAt,code:"OVERLAY_CONFLICT" }))];
  for (const o of obligations) {
    const representation = (w:PaintWorld) => w.hours.flatMap(h => !o.people.includes(h.employeeId) ? [] : h.segments
      .filter(s => overlaps(s,o)).map(s => [h.shiftId,Math.max(s.startMs,o.startMs),Math.min(s.endMs,o.endMs),s.state,s.stationId]));
    if (JSON.stringify(representation(before)) !== JSON.stringify(representation(after))) throw new QuarterRefused(o.code,422);
  }
}
