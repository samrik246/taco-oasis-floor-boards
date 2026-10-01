import { prisma } from "@/lib/db";
import { projectCoverDisplay } from "./cover-display";

/** Both boards and all recorded movers are read in one SQLite snapshot, using safe fields only. */
export async function loadCoverDisplay(board: string, date: string, now = new Date()) {
  return prisma.$transaction(async db => {
    const [shifts, stations, bookings, overlays] = await Promise.all([
      db.shift.findMany({ where: { date }, select: {
        id: true, employeeId: true, date: true, board: true, sourcePosition: true, startAt: true, endAt: true, supersededAt: true, boardRemoved: true,
        employee: { select: { firstName: true, lastName: true } },
        assignments: { select: { stationId: true, hourStart: true, hourEnd: true } },
      } }),
      db.station.findMany({ select: { id: true, board: true, label: true, color: true } }),
      db.staffBreak.findMany({ where: { date, status: "booked" }, select: {
        id: true, employeeId: true, shiftId: true, board: true, date: true, status: true, startAt: true, endAt: true,
        coverEmployeeId: true, coverShiftId: true, shuffleEmployeeId: true, shuffleShiftId: true, auto: true,
      } }),
      db.boardOverlay.findMany({ where: { date }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: {
        board: true, kind: true, employeeId: true, partnerEmployeeId: true, stationId: true, fromStationId: true,
        startAt: true, endAt: true, cancelledAt: true,
      } }),
    ]);
    return projectCoverDisplay({ board, date, now, shifts, stations, bookings, overlays });
  });
}
