import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod";

export const runtime = "nodejs";

const paramsSchema = z.object({
  board: z.enum(["caja", "cocina"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type RouteContext = { params: Promise<{ board: string; date: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const raw = await context.params;
    const { board, date } = paramsSchema.parse(raw);

    const [stations, shifts] = await Promise.all([
      prisma.station.findMany({
        where: { board },
        orderBy: { sortOrder: "asc" },
      }),
      prisma.shift.findMany({
        where: { board, date },
        include: {
          employee: true,
          assignments: {
            include: { station: true },
            orderBy: { hourStart: "asc" },
          },
        },
        orderBy: [{ startAt: "asc" }, { sourcePosition: "asc" }],
      }),
    ]);

    return NextResponse.json({
      board,
      date,
      stations: stations.map((s) => ({
        id: s.id,
        label: s.label,
        color: s.color,
        maxConcurrent: s.maxConcurrent,
        sortOrder: s.sortOrder,
        priority: s.priority,
      })),
      shifts: shifts.map((sh) => ({
        id: sh.id,
        date: sh.date,
        startAt: sh.startAt.toISOString(),
        endAt: sh.endAt.toISOString(),
        sourcePosition: sh.sourcePosition,
        board: sh.board,
        employee: {
          id: sh.employee.id,
          externalId: sh.employee.externalId,
          firstName: sh.employee.firstName,
          lastName: sh.employee.lastName,
          email: sh.employee.email,
        },
        assignments: sh.assignments.map((a) => ({
          id: a.id,
          stationId: a.stationId,
          hourStart: a.hourStart.toISOString(),
          hourEnd: a.hourEnd.toISOString(),
        })),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bad request";
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid board or date", details: err.issues }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
