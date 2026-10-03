import { assignedPaint, intersectingPaint } from "@/lib/quarter/client/intervals";
import { chicagoHourEnd, chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
import { canJoinCoverSegments, type CoverSegment, type CoverTrack } from "@/lib/board/cover-display";
import type { DayBoardDto } from "./types";

export function clipSegment(segment: CoverSegment, start: number, end: number): CoverSegment | null {
  const left = Math.max(Date.parse(segment.startAt), start), right = Math.min(Date.parse(segment.endAt), end);
  return left < right ? { ...segment, startAt: new Date(left).toISOString(), endAt: new Date(right).toISOString() } : null;
}

/** Join only visually identical neighbours; saved intervals remain untouched. */
export function joinedDisplaySegments(segments: readonly CoverSegment[]): CoverSegment[] {
  const joined: CoverSegment[] = [];
  for (const segment of segments) {
    const previous = joined.at(-1);
    if (previous && canJoinCoverSegments(previous, segment)) previous.endAt = segment.endAt;
    else joined.push({ ...segment });
  }
  return joined;
}

export function isSplitDisplayHour(segments: readonly CoverSegment[], start: number, end: number): boolean {
  const joined = joinedDisplaySegments(segments);
  return joined.length > 1 || Boolean(joined.length && (Date.parse(joined[0].startAt) !== start || Date.parse(joined[0].endAt) !== end));
}

/** Only marked hours need to split the existing joined schedule blocks. */
export function savedHourSegments(day: DayBoardDto, shiftId: string, hour: number, merge = false): CoverSegment[] | null {
  const start = +chicagoHourStart(day.date, hour), end = +chicagoHourEnd(day.date, hour);
  const track = day.coverDisplay?.tracks.find(t => t.shiftId === shiftId);
  if (track) {
    const segments = (merge ? joinedDisplaySegments(track.segments) : track.segments).flatMap(s => { const part = clipSegment(s, start, end); return part ? [part] : []; });
    return day.quarter || segments.some(s => s.kind !== "work") ? segments : null;
  }
  if (day.quarter) {
    const source=day.shifts.find(s=>s.id===shiftId);
    if(!source)return null;
    return intersectingPaint(source,start,end).filter(i=>i.state!=="off").map(i=>{
      const station=day.stations.find(s=>s.id===i.stationId);
      return {startAt:i.startAt,endAt:i.endAt,kind:"work" as const,station:station?{id:station.id,board:day.board,label:station.label,color:station.color,shortCode:station.shortCode}:null,fromStation:null,auto:false};
    });
  }
  if (day.coverDisplay) return null;
  // Old snapshots can show the saved BREAK interval, but cannot invent a cover identity/seat.
  const shift = day.shifts.find(s => s.id === shiftId);
  const breaks = (day.breaks ?? []).filter(b => b.shiftId === shiftId && b.employeeId === shift?.employee.id && Date.parse(b.startAt) < end && Date.parse(b.endAt) > start);
  if (!shift || !breaks.length) return null;
  const left = Math.max(start, Date.parse(shift.startAt)), right = Math.min(end, Date.parse(shift.endAt));
  const bounds = [...new Set([left, right, ...breaks.flatMap(b => [Math.max(left, Date.parse(b.startAt)), Math.min(right, Date.parse(b.endAt))])])].sort((a, b) => a - b);
  return bounds.slice(0, -1).flatMap((a, i) => {
    const b = bounds[i + 1]; if (b <= a) return [];
    const assignment = shift.assignments.find(p => Date.parse(p.hourStart) <= a && Date.parse(p.hourEnd) >= b);
    const station = day.stations.find(s => s.id === assignment?.stationId);
    return [{ startAt: new Date(a).toISOString(), endAt: new Date(b).toISOString(), kind: breaks.some(p => Date.parse(p.startAt) <= a && Date.parse(p.endAt) >= b) ? "break" as const : "work" as const,
      station: station ? { id: station.id, board: day.board, label: station.label, color: station.color } : null, fromStation: null, auto: false }];
  });
}

export type StationInterval = { employeeId: string; shiftId: string; name: string; startAt: string; endAt: string; cover: boolean };
/** The wall shows current occupancy; the floor retains its complete hour summary. */
export function savedStationOccupantsNow(day: DayBoardDto, stationId: string, now: Date): StationInterval[] | null {
  const intervals = savedStationIntervals(day, stationId, chicagoHourOf(now));
  return intervals?.filter(row => Date.parse(row.startAt) <= +now && +now < Date.parse(row.endAt)) ?? null;
}

export function savedStationIntervals(day: DayBoardDto, stationId: string, hour: number): StationInterval[] | null {
  const start = +chicagoHourStart(day.date, hour), end = +chicagoHourEnd(day.date, hour);
  const tracks = day.coverDisplay?.tracks ?? [];
  const affected = tracks.some(t => t.segments.some(s => s.kind !== "work" && Date.parse(s.startAt) < end && Date.parse(s.endAt) > start
    && (s.station?.id === stationId || s.fromStation?.id === stationId)))
    || day.shifts.some(s => assignedPaint(s).some(a => a.stationId === stationId && Date.parse(a.startAt) < end && Date.parse(a.endAt) > start)
      && savedHourSegments(day, s.id, hour));
  if (!affected && !day.quarter) return null;
  const rows: StationInterval[] = [];
  const append = (track: Pick<CoverTrack, "shiftId" | "employeeId" | "firstName" | "lastName">, segment: CoverSegment) => {
    const part = clipSegment(segment, start, end);
    if (!part || part.kind === "break" || part.station?.id !== stationId || part.station.board !== day.board) return;
    rows.push({ employeeId: track.employeeId, shiftId: track.shiftId, name: `${track.firstName} ${track.lastName}`.trim(), startAt: part.startAt, endAt: part.endAt, cover: part.kind === "cover" });
  };
  for (const track of tracks) for (const s of track.segments) append(track, s);
  for (const shift of day.shifts) {
    if (tracks.some(t => t.shiftId === shift.id)) continue;
    const fallback = savedHourSegments(day, shift.id, hour);
    if (fallback) { for (const s of fallback) append({ shiftId: shift.id, employeeId: shift.employee.id, ...shift.employee }, s); continue; }
    for (const a of assignedPaint(shift)) {
      const station = day.stations.find(s => s.id === a.stationId);
      if (!station) continue;
      append({ shiftId: shift.id, employeeId: shift.employee.id, ...shift.employee }, { startAt: new Date(Math.max(Date.parse(shift.startAt), Date.parse(a.startAt))).toISOString(),
        endAt: new Date(Math.min(Date.parse(shift.endAt), Date.parse(a.endAt))).toISOString(), kind: "work", station: { ...station, board: day.board }, fromStation: null, auto: false });
    }
  }
  return rows.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.employeeId.localeCompare(b.employeeId));
}
