import { z } from "zod";
import { familyForStation, PAINT_FAMILIES } from "@/lib/assignments/paint-families";
import { isDefaultMandatory } from "@/lib/mandatory";

const stationSchema = z.object({ id: z.string(), board: z.string(), label: z.string(), color: z.string() });
const segmentSchema = z.object({
  startAt: z.iso.datetime(), endAt: z.iso.datetime(), kind: z.enum(["work", "break", "cover"]),
  station: stationSchema.nullable(), fromStation: stationSchema.nullable(), auto: z.boolean(),
});
/** An allowlist shared by the public read and the offline cache. Unknown fields are dropped. */
export const coverDisplaySchema = z.object({
  version: z.literal(1),
  tracks: z.array(z.object({
    shiftId: z.string(), employeeId: z.string(), firstName: z.string(), lastName: z.string(),
    board: z.string(), startAt: z.iso.datetime(), endAt: z.iso.datetime(), segments: z.array(segmentSchema),
  })),
  unavailable: z.array(z.object({ id: z.string(), employeeId: z.string(), firstName: z.string(), lastName: z.string(), startAt: z.iso.datetime(), endAt: z.iso.datetime() })),
});
export type CoverDisplay = z.infer<typeof coverDisplaySchema>;
export type CoverTrack = CoverDisplay["tracks"][number];
export type CoverSegment = CoverTrack["segments"][number];
type Station = z.infer<typeof stationSchema>;
export type CoverDisplayShift = {
  id: string; employeeId: string; date: string; board: string; startAt: Date; endAt: Date;
  supersededAt: Date | null; boardRemoved: boolean;
  employee: { firstName: string; lastName: string };
  assignments: { stationId: string; hourStart: Date; hourEnd: Date }[];
};
export type CoverDisplayBooking = {
  id: string; employeeId: string; shiftId: string; board: string; date: string;
  status: string; startAt: Date; endAt: Date; coverEmployeeId: string | null;
  coverShiftId: string | null; shuffleEmployeeId: string | null; shuffleShiftId: string | null; auto: boolean;
};
export type CoverDisplayOverlay = {
  board: string; kind: string; employeeId: string; partnerEmployeeId: string | null;
  stationId: string; fromStationId: string | null; startAt: Date; endAt: Date; cancelledAt: Date | null;
};
const overlap = (a: Date, b: Date, c: Date, d: Date) => a < d && c < b;

/** Pure saved-evidence projection. No picker, replacement, write, ability or headcount data. */
export function projectCoverDisplay(input: {
  board: string; date: string; now: Date; shifts: CoverDisplayShift[];
  stations: Station[]; bookings: CoverDisplayBooking[]; overlays: CoverDisplayOverlay[];
}): CoverDisplay {
  const stations = new Map(input.stations.map(s => [s.id, s]));
  const shifts = new Map(input.shifts.map(s => [s.id, s]));
  const bookings = input.bookings.filter(b => b.date === input.date && b.status === "booked");
  // Match the existing screen rule for ended/cancelled overlays. Their history stays in the overlay list.
  const overlays = input.overlays.filter(o => !o.cancelledAt && o.endAt > input.now);
  const bounds = [...new Set([
    ...input.shifts.flatMap(s => [+s.startAt, +s.endAt, ...s.assignments.flatMap(a => [+a.hourStart, +a.hourEnd])]),
    ...bookings.flatMap(b => [+b.startAt, +b.endAt]), ...overlays.flatMap(o => [+o.startAt, +o.endAt]),
  ])].sort((a, b) => a - b);
  const intervals = bounds.slice(0, -1).map((t, i) => [t, bounds[i + 1]] as const);
  const parts = (start: Date, end: Date) => intervals.filter(([a, b]) => a >= +start && b <= +end);
  function exact(id: string | null, employeeId: string | null, b: CoverDisplayBooking) {
    const s = id ? shifts.get(id) : undefined;
    if (!s || !employeeId || s.employeeId !== employeeId || s.date !== input.date || s.supersededAt || s.boardRemoved
      || s.startAt > b.startAt || s.endAt < b.endAt || b.startAt >= b.endAt) return null;
    // Ambiguous overlapping source shifts cannot rescue or override the recorded identity.
    if (input.shifts.some(other => other.id !== s.id && other.employeeId === employeeId && !other.supersededAt && !other.boardRemoved && other.date === input.date
      && overlap(other.startAt, other.endAt, b.startAt, b.endAt))) return null;
    return s;
  }
  function position(s: CoverDisplayShift, start: number, end: number): { station: Station | null; ambiguous: boolean; overlay: CoverDisplayOverlay | undefined } {
    const active = overlays.filter(o => o.startAt.getTime() <= start && o.endAt.getTime() >= end
      && (o.employeeId === s.employeeId || o.partnerEmployeeId === s.employeeId));
    // Newest-first precedence matches loadOverlayRecords/buildDaySlices; cross-board overlaps are ambiguous.
    const overlay = active[0];
    const paints = s.assignments.filter(a => +a.hourStart <= start && +a.hourEnd >= end);
    let id: string | null = paints[0]?.stationId ?? null;
    if (overlay?.kind === "remove" && overlay.employeeId === s.employeeId) id = null;
    else if (overlay?.kind === "switch") id = overlay.employeeId === s.employeeId ? overlay.stationId : overlay.fromStationId;
    else if (overlay?.kind === "add" && overlay.partnerEmployeeId === s.employeeId) id = overlay.stationId;
    return { station: id ? stations.get(id) ?? null : null,
      ambiguous: new Set(paints.map(p => p.stationId)).size > 1 || new Set(active.map(o => o.board)).size > 1 || Boolean(id && !stations.has(id)), overlay };
  }
  const participants = (b: CoverDisplayBooking) => [b.employeeId, b.coverEmployeeId, b.shuffleEmployeeId].filter((id): id is string => Boolean(id));
  const plans = bookings.map(b => {
    const requester = exact(b.shiftId, b.employeeId, b);
    const cover = exact(b.coverShiftId, b.coverEmployeeId, b);
    const shuffle = exact(b.shuffleShiftId, b.shuffleEmployeeId, b);
    const hasCover = Boolean(b.coverEmployeeId || b.coverShiftId);
    const hasShuffle = Boolean(b.shuffleEmployeeId || b.shuffleShiftId);
    let valid = Boolean(requester && requester.board === b.board && (!hasCover || cover) && (!hasShuffle || (cover && shuffle)));
    const ids = participants(b);
    if (new Set(ids).size !== ids.length || bookings.some(other => other.id !== b.id && overlap(b.startAt, b.endAt, other.startAt, other.endAt)
      && participants(other).some(id => ids.includes(id)))) valid = false;
    const movements: { start: number; end: number; shiftId: string; station: Station; fromStation: Station | null }[] = [];
    if (valid && requester) for (const [start, end] of parts(b.startAt, b.endAt)) {
      const dest = position(requester, start, end);
      if (dest.ambiguous || (hasCover && (!dest.station || dest.station.board !== b.board))) { valid = false; break; }
      if (!cover || !dest.station) continue;
      const origin = position(cover, start, end);
      if (origin.ambiguous) { valid = false; break; }
      if (origin.overlay) {
        const family = familyForStation(dest.station.id);
        const numbered = family && isDefaultMandatory(dest.station.id) && PAINT_FAMILIES[family][0] === dest.station.id
          && PAINT_FAMILIES[family][1] === origin.station?.id;
        if (!numbered) { valid = false; break; }
      }
      movements.push({ start, end, shiftId: cover.id, station: dest.station, fromStation: origin.station });
      if (shuffle) {
        const second = position(shuffle, start, end);
        if (!origin.station || origin.station.board !== b.board || origin.station.id === dest.station.id || second.ambiguous || second.overlay) { valid = false; break; }
        movements.push({ start, end, shiftId: shuffle.id, station: origin.station, fromStation: second.station });
      }
    }
    return { b, requester, cover, shuffle, valid, movements: valid ? movements : [] };
  });
  const relevant = plans.filter(p => p.b.board === input.board || [p.requester, p.cover, p.shuffle].some(s => s?.board === input.board)
    || p.movements.some(m => m.station.board === input.board || m.fromStation?.board === input.board));
  const trackShifts = new Map<string, CoverDisplayShift>();
  for (const p of relevant) for (const s of [p.requester, p.cover, p.shuffle]) if (s) trackShifts.set(s.id, s);
  const allMovements = plans.flatMap(p => p.movements.map(m => ({ ...m, auto: p.b.auto })));
  const tracks = [...trackShifts.values()].map(s => {
    const segments: CoverSegment[] = [];
    for (const [start, end] of parts(s.startAt, s.endAt)) {
      const resting = plans.find(p => p.requester?.id === s.id && +p.b.startAt <= start && +p.b.endAt >= end);
      const moving = allMovements
        .find(m => m.shiftId === s.id && m.start <= start && m.end >= end);
      const base = position(s, start, end);
      const segment: CoverSegment = { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
        kind: resting ? "break" : moving ? "cover" : "work", station: resting ? base.station : moving?.station ?? base.station,
        fromStation: moving?.fromStation ?? null, auto: moving?.auto ?? false };
      const previous = segments.at(-1);
      if (previous && previous.endAt === segment.startAt && previous.kind === segment.kind && previous.station?.id === segment.station?.id
        && previous.fromStation?.id === segment.fromStation?.id && previous.auto === segment.auto) previous.endAt = segment.endAt;
      else segments.push(segment);
    }
    return { shiftId: s.id, employeeId: s.employeeId, firstName: s.employee.firstName, lastName: s.employee.lastName,
      board: s.board, startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), segments };
  });
  return coverDisplaySchema.parse({ version: 1, tracks, unavailable: relevant.filter(p => !p.valid).map(p => ({
    id: p.b.id, employeeId: p.b.employeeId, firstName: p.requester?.employee.firstName ?? "", lastName: p.requester?.employee.lastName ?? "",
    startAt: p.b.startAt.toISOString(), endAt: p.b.endAt.toISOString(),
  })) });
}
