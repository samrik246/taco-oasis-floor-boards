import type { Assignment, Shift, Station } from "@prisma/client";
import { chicagoHourStart, hourGridHours } from "@/lib/hour-grid";
import { QuarterRefused, canonical, digest, quarterState, worldRevision, type QuarterDb } from "./schema";

export const HOUR_MS = 3_600_000;
export const QUARTER_MS = 900_000;
export type Source = Pick<Shift, "id" | "employeeId" | "date" | "board" | "sourcePosition" | "startAt" | "endAt" | "supersededAt" | "boardRemoved">;
export type Segment = { id: string; quarterStartMs: number; startMs: number; endMs: number; state: "assigned" | "erased" | "off"; stationId: string | null; seatNumber: number | null; assignmentId?: string };
export type PaintHour = { id: string | null; shiftId: string; employeeId: string; date: string; board: string; hourStartMs: number; revision: string | null; sourceJson: string; sourceSha256: string; legacyJson: string; legacySha256: string; segments: Segment[] };
export type PaintWorld = { date: string; state: Awaited<ReturnType<typeof quarterState>>; revision: string | null; sources: Source[]; stations: Station[]; hours: PaintHour[] };
export const hourKey = (shiftId: string, start: number) => `${shiftId}|${start}`;
export const overlaps = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => a.startMs < b.endMs && b.startMs < a.endMs;
export function sourceSnapshot(s: Source) {
  return { shiftId: s.id, employeeId: s.employeeId, date: s.date, board: s.board, sourcePosition: s.sourcePosition,
    startAtMs: s.startAt.getTime(), endAtMs: s.endAt.getTime(), supersededAtMs: s.supersededAt?.getTime() ?? null, boardRemoved: s.boardRemoved };
}
export function legacySnapshot(rows: Assignment[]) {
  return rows.map(a => ({ id: a.id, shiftId: a.shiftId, employeeId: a.employeeId, stationId: a.stationId,
    startMs: a.hourStart.getTime(), endMs: a.hourEnd.getTime(), seatNumber: a.seatNumber })).sort((a,b) => a.id.localeCompare(b.id));
}
export function legacyHour(source: Source, start: number, assignments: Assignment[]): PaintHour {
  const rows = assignments.filter(a => a.hourStart.getTime() < start + HOUR_MS && a.hourEnd.getTime() > start);
  const boundaries = new Set([start, start + HOUR_MS]);
  for (let q = start; q < start + HOUR_MS; q += QUARTER_MS) boundaries.add(q);
  for (const n of [source.startAt.getTime(), source.endAt.getTime(), ...rows.flatMap(a => [a.hourStart.getTime(), a.hourEnd.getTime()])])
    if (n > start && n < start + HOUR_MS) boundaries.add(n);
  const sorted = [...boundaries].sort((a,b) => a-b);
  const segments: Segment[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const startMs = sorted[i-1], endMs = sorted[i];
    const on = startMs >= source.startAt.getTime() && endMs <= source.endAt.getTime();
    const matching = on ? rows.filter(a => a.hourStart.getTime() <= startMs && a.hourEnd.getTime() >= endMs) : [];
    if (matching.length > 1) throw new QuarterRefused("LEGACY_INTERVAL_CONFLICT");
    const a = matching[0];
    segments.push({ id: `legacy:${source.id}:${startMs}`, quarterStartMs: start + Math.floor((startMs-start)/QUARTER_MS)*QUARTER_MS,
      startMs, endMs, state: !on ? "off" : a ? "assigned" : "erased", stationId: a?.stationId ?? null, seatNumber: a?.seatNumber ?? null,
      ...(a ? { assignmentId: a.id } : {}) });
  }
  const snapshot = sourceSnapshot(source), legacy = legacySnapshot(rows);
  return { id: null, shiftId: source.id, employeeId: source.employeeId, date: source.date, board: source.board, hourStartMs: start,
    revision: null, sourceJson: canonical(snapshot), sourceSha256: digest(snapshot), legacyJson: canonical(legacy), legacySha256: digest(legacy), segments };
}
export function assertPartition(hour: PaintHour, source: Source): void {
  if (hour.shiftId !== source.id || hour.employeeId !== source.employeeId || hour.date !== source.date || hour.board !== source.board ||
    hour.sourceJson !== canonical(sourceSnapshot(source)) || hour.sourceSha256 !== digest(sourceSnapshot(source)) ||
    digest(JSON.parse(hour.legacyJson)) !== hour.legacySha256) throw new QuarterRefused("QUARTER_SOURCE_MISMATCH");
  let cursor = hour.hourStartMs;
  for (const s of hour.segments) {
    const q = hour.hourStartMs + Math.floor((s.startMs-hour.hourStartMs)/QUARTER_MS)*QUARTER_MS;
    const on = s.startMs >= source.startAt.getTime() && s.endMs <= source.endAt.getTime();
    const off = s.endMs <= source.startAt.getTime() || s.startMs >= source.endAt.getTime();
    if (s.startMs !== cursor || s.endMs <= s.startMs || s.quarterStartMs !== q || s.endMs > q + QUARTER_MS ||
      !Number.isSafeInteger(s.startMs) || !Number.isSafeInteger(s.endMs) ||
      (s.state === "off" ? !off : !on) || (s.state === "assigned" ? !s.stationId : s.stationId !== null || s.seatNumber !== null))
      throw new QuarterRefused("QUARTER_PARTITION_INVALID");
    cursor = s.endMs;
  }
  if (cursor !== hour.hourStartMs + HOUR_MS) throw new QuarterRefused("QUARTER_PARTITION_INCOMPLETE");
}
/** A caller-supplied transaction provides one snapshot for both boards and every consumer. */
export async function resolvePaintWorld(db: QuarterDb, date: string): Promise<PaintWorld> {
  const state = await quarterState(db);
  const sources = await db.shift.findMany({ where: { date }, select: { id:true, employeeId:true, date:true, board:true,
    sourcePosition:true, startAt:true, endAt:true, supersededAt:true, boardRemoved:true } });
  const assignments = await db.assignment.findMany({ where: { shift: { date } } });
  const stations = await db.station.findMany();
  const rawHours = state ? await db.$queryRawUnsafe<(Omit<PaintHour,"segments" | "hourStartMs"> & { hourStartMs: string })[]>(
    "SELECT id,shiftId,employeeId,date,board,CAST(hourStartMs AS TEXT) hourStartMs,CAST(revision AS TEXT) revision,sourceJson,sourceSha256,legacyJson,legacySha256 FROM PaintHour WHERE date=?", date) : [];
  const rawSegments = state ? await db.$queryRawUnsafe<(Segment & { paintHourId:string })[]>(
    "SELECT s.id,s.paintHourId,CAST(s.quarterStartMs AS TEXT) quarterStartMs,CAST(s.startMs AS TEXT) startMs,CAST(s.endMs AS TEXT) endMs,s.state,s.stationId,s.seatNumber FROM PaintSegment s JOIN PaintHour h ON h.id=s.paintHourId WHERE h.date=? ORDER BY s.startMs",date) : [];
  if (state?.phase === "prepared" && rawHours.length) throw new QuarterRefused("QUARTER_PREPARED_HAS_PAINT",503);
  const adopted = new Map(rawHours.map(h => [hourKey(h.shiftId,Number(h.hourStartMs)),h]));
  const hours: PaintHour[] = [];
  for (const source of sources) {
    for (const wallHour of hourGridHours()) {
      const start = chicagoHourStart(date,wallHour).getTime();
      const stored = adopted.get(hourKey(source.id,start));
      if (!stored && (source.endAt.getTime() <= start || source.startAt.getTime() >= start + HOUR_MS)) continue;
      const hour: PaintHour = stored ? { ...stored, hourStartMs:start, segments:rawSegments.filter(s => s.paintHourId === stored.id).map(s => ({
        id:s.id, startMs:Number(s.startMs), endMs:Number(s.endMs), quarterStartMs:Number(s.quarterStartMs), state:s.state,
        stationId:s.stationId, seatNumber:s.seatNumber === null ? null : Number(s.seatNumber),
      })) } : legacyHour(source,start,assignments.filter(a => a.shiftId === source.id));
      assertPartition(hour,source);
      hours.push(hour);
      adopted.delete(hourKey(source.id,start));
    }
  }
  if (adopted.size) throw new QuarterRefused("QUARTER_ORPHAN_HOUR");
  return { date,state,revision:state ? await worldRevision(db) : null,sources,stations,hours };
}
export function assignedIntervals(world: PaintWorld, liveOnly = true) {
  const sources = new Map(world.sources.map(s => [s.id,s]));
  return world.hours.flatMap(h => {
    const source = sources.get(h.shiftId)!;
    if (liveOnly && (source.supersededAt || source.boardRemoved)) return [];
    return h.segments.filter(s => s.state === "assigned").map(s => ({ ...s, shiftId:h.shiftId, employeeId:h.employeeId, board:h.board,
      provenance:h.id ? { kind:"v2" as const, paintHourId:h.id, revision:h.revision!, segmentId:s.id } : { kind:"legacy" as const, assignmentId:s.assignmentId! } }));
  });
}
