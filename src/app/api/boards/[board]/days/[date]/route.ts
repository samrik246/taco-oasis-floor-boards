import { legacyHttpGuard } from "@/lib/quarter/http";
import { loadCoverDisplay } from "@/lib/board/load-cover-display";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { NO_STORE, optionalManager, requireDayAccess } from "@/lib/managers/day-access";
import { requestIsOwner } from "@/lib/managers/require-session";
import { levelWhenUnset } from "@/lib/abilities/column-default";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { loadMandatoryDay } from "@/lib/mandatory-store";
import { fillMissingSeatNumbers } from "@/lib/assignments/seat-number";
import { loadStationUse } from "@/lib/assignments/station-use";
import { boardBreakStripes } from "@/lib/breaks/stripe";
import { loadOverlayRecords, overlayDto } from "@/lib/overlays/read";
import { chicagoToday } from "@/lib/upcoming/source";
import { isAuxiliaryPosition, isMainBoardPosition } from "@/lib/board/auxiliary";
import { paletteStationIds } from "@/lib/assignments/palette-order";

export const runtime = "nodejs";

const paramsSchema = z.object({
  board: z.enum(["caja", "cocina"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type RouteContext = { params: Promise<{ board: string; date: string }> };

/** Today is open to staff; any other day needs a manager session. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const raw = await context.params;
    const { board, date } = paramsSchema.parse(raw);
    const access = await requireDayAccess(request, date);
    if (!access.ok) return access.response;
    const upgrade = await legacyHttpGuard();
    if (upgrade) return upgrade;
    const manager = await optionalManager(request);
    const owner = manager ? await requestIsOwner(request) : false;

    const [stations, boardShifts, columnDefaults, auxiliaryCandidates, mandatory] = await Promise.all([
      prisma.station.findMany({
        where: { board },
        orderBy: { sortOrder: "asc" },
      }),
      prisma.shift.findMany({
        // A superseded shift shows only while it holds history (started, assigned hours).
        where: {
          board,
          date,
          boardRemoved: false,
          OR: [{ supersededAt: null }, { assignments: { some: {} } }],
        },
        include: {
          employee: {
            include: {
              abilities: true,
            },
          },
          assignments: {
            include: { station: true },
            orderBy: { hourStart: "asc" },
          },
        },
        orderBy: [{ startAt: "asc" }, { sourcePosition: "asc" }],
      }),
      loadColumnDefaults(prisma),
      prisma.shift.findMany({
        where: { date, boardRemoved: false, supersededAt: null },
        select: { id: true, date: true, startAt: true, endAt: true, sourcePosition: true,
          employee: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: [{ startAt: "asc" }, { sourcePosition: "asc" }, { id: "asc" }],
      }),
      loadMandatoryDay(board, date, owner),
    ]);

    const shifts = boardShifts.filter(shift => isMainBoardPosition(shift.sourcePosition));
    const stationUse = await loadStationUse(board, date, stations.map(station => station.id));
    const stationIds = paletteStationIds({ stations, stationUse, extraStationIds: mandatory.extraStationIds });
    const byId = new Map(stations.map(station => [station.id, station]));

    const seatNumbers = fillMissingSeatNumbers(shifts.flatMap((sh) => sh.assignments.map((a) => ({
      id: a.id,
      stationId: a.stationId,
      hourStartMs: a.hourStart.getTime(),
      seatNumber: a.seatNumber,
    }))));

    const body = {
      board,
      date,
      // Presentation ranks shared by Horario, Pintar, tiles and menus. Stored order is unchanged.
      stations: stationIds.map((id, rank) => ({ ...byId.get(id)!, sortOrder: rank })).map((s) => ({
        id: s.id,
        label: s.label,
        color: s.color,
        maxConcurrent: s.maxConcurrent,
        sortOrder: s.sortOrder,
        priority: s.priority,
        shortCode: s.shortCode,
      })),
      auxiliaryShifts: auxiliaryCandidates.filter(shift => isAuxiliaryPosition(shift.sourcePosition)).map(shift => ({
        ...shift, startAt: shift.startAt.toISOString(), endAt: shift.endAt.toISOString(),
      })),
      shifts: shifts.map((sh) => ({
        id: sh.id,
        date: sh.date,
        startAt: sh.startAt.toISOString(),
        endAt: sh.endAt.toISOString(),
        sourcePosition: sh.sourcePosition,
        board: sh.board,
        supersededAt: sh.supersededAt ? sh.supersededAt.toISOString() : null,
        employee: {
          id: sh.employee.id,
          firstName: sh.employee.firstName,
          lastName: sh.employee.lastName,
          email: sh.employee.email,
          ...(owner
            ? {
                abilities: [
                  ...sh.employee.abilities.map((a) => ({
                    stationId: a.stationId,
                    level: a.level,
                  })),
                  ...[...columnDefaults.entries()]
                    .filter(([stationId, level]) =>
                      level === "forbidden" &&
                      !sh.employee.abilities.some((a) => a.stationId === stationId),
                    )
                    .map(([stationId]) => ({ stationId, level: "forbidden" as const })),
                ],
              }
            : {}),
        },
        assignments: sh.assignments.map((a) => ({
          id: a.id,
          stationId: a.stationId,
          hourStart: a.hourStart.toISOString(),
          hourEnd: a.hourEnd.toISOString(),
          abilityBlocked: levelWhenUnset(
            sh.employee.abilities.find((ability) => ability.stationId === a.stationId)?.level,
            columnDefaults.get(a.stationId),
          ) === "forbidden",
          seatNumber: seatNumbers.get(a.id) ?? null,
        })),
      })),
      stationUse,
      breaks: await boardBreakStripes(board, date),
      coverDisplay: await loadCoverDisplay(board, date),
      overlays: (await loadOverlayRecords(prisma, board, date)).map(overlayDto),
      overlayMenu: Boolean(manager) && date === chicagoToday(),
      ...(manager ? { mandatory } : {}),
    };

    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bad request";
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid board or date", details: err.issues }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
