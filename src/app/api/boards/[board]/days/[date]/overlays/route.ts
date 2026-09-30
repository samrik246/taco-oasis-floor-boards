import { NextResponse } from "next/server";
import { z } from "zod";
import { NO_STORE } from "@/lib/managers/day-access";
import { requireManagerSession } from "@/lib/managers/require-session";
import { OverlayRefused, saveOverlay } from "@/lib/overlays/write";
import { chicagoToday } from "@/lib/upcoming/source";

export const runtime = "nodejs";

const paramsSchema = z.object({
  board: z.enum(["caja", "cocina"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const bodySchema = z.object({
  kind: z.enum(["switch", "remove", "add"]),
  employeeId: z.string().min(1),
  partnerEmployeeId: z.string().min(1).nullable().optional(),
  stationId: z.string().min(1).nullable().optional(),
  window: z.enum(["whole", "rest", "quarters"]),
  startAt: z.string().min(1).nullable().optional(),
  endAt: z.string().min(1).nullable().optional(),
});

type RouteContext = { params: Promise<{ board: string; date: string }> };

function absent() {
  return NextResponse.json({ error: "NOT_TODAY" }, { status: 404, headers: NO_STORE });
}

/** Any day that is not the server's Central today has no menu route. */
export async function POST(request: Request, context: RouteContext) {
  let board: "caja" | "cocina";
  let date: string;
  try {
    const parsed = paramsSchema.parse(await context.params);
    board = parsed.board;
    date = parsed.date;
  } catch {
    return NextResponse.json({ error: "BAD_DATE" }, { status: 400, headers: NO_STORE });
  }
  if (date !== chicagoToday()) return absent();
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "WINDOW" }, { status: 400, headers: NO_STORE });
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) {
    return NextResponse.json({ error: "WINDOW" }, { status: 400, headers: NO_STORE });
  }
  try {
    const saved = await saveOverlay({
      manager: { id: auth.manager.id, name: auth.manager.name },
      board,
      date,
      kind: body.data.kind,
      employeeId: body.data.employeeId,
      partnerEmployeeId: body.data.partnerEmployeeId,
      stationId: body.data.stationId,
      window: body.data.window,
      startAt: body.data.startAt ? new Date(body.data.startAt) : null,
      endAt: body.data.endAt ? new Date(body.data.endAt) : null,
    });
    return NextResponse.json(saved, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof OverlayRefused) {
      const status = error.code === "NOT_TODAY" ? 404 : 422;
      return NextResponse.json({ error: error.code }, { status, headers: NO_STORE });
    }
    throw error;
  }
}
