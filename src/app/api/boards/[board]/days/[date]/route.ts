import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { NO_STORE, optionalManager, requireDayAccess } from "@/lib/managers/day-access";
import { requestIsOwner } from "@/lib/managers/require-session";
import { loadMandatoryDay } from "@/lib/mandatory-store";
import { fillMissingSeatNumbers } from "@/lib/assignments/seat-number";
import { loadStationUse } from "@/lib/assignments/station-use";

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
    const manager = await optionalManager(request);
    const owner = manager ? await requestIsOwner(request) : false;

    const [stations, shifts] = await Promise.all([
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
    ]);

    const seatNumbers = fillMissingSeatNumbers(shifts.flatMap((sh) => sh.assignments.map((a) => ({
      id: a.id,
      stationId: a.stationId,
      hourStartMs: a.hourStart.getTime(),
      seatNumber: a.seatNumber,
    }))));

    const body = {
      board,
      date,
      stations: stations.map((s) => ({
        id: s.id,
        label: s.label,
        color: s.color,
        maxConcurrent: s.maxConcurrent,
        sortOrder: s.sortOrder,
        priority: s.priority,
        shortCode: s.shortCode,
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
          externalId: sh.employee.externalId,
          firstName: sh.employee.firstName,
          lastName: sh.employee.lastName,
          email: sh.employee.email,
          ...(owner
            ? {
                abilities: sh.employee.abilities.map((a) => ({
                  stationId: a.stationId,
                  level: a.level,
                })),
              }
            : {}),
        },
        assignments: sh.assignments.map((a) => ({
          id: a.id,
          stationId: a.stationId,
          hourStart: a.hourStart.toISOString(),
          hourEnd: a.hourEnd.toISOString(),
          abilityBlocked: sh.employee.abilities.some(
            (ability) => ability.stationId === a.stationId && ability.level === "forbidden",
          ),
          seatNumber: seatNumbers.get(a.id) ?? null,
        })),
      })),
      stationUse: await loadStationUse(board, date, stations.map((s) => s.id)),
      ...(manager ? { mandatory: await loadMandatoryDay(board, date, owner) } : {}),
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
