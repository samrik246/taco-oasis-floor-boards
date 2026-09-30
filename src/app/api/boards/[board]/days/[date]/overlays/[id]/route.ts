import { NextResponse } from "next/server";
import { z } from "zod";
import { NO_STORE } from "@/lib/managers/day-access";
import { requireManagerSession } from "@/lib/managers/require-session";
import { cancelOverlay, OverlayRefused } from "@/lib/overlays/write";
import { chicagoToday } from "@/lib/upcoming/source";

export const runtime = "nodejs";

const paramsSchema = z.object({
  board: z.enum(["caja", "cocina"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  id: z.string().min(1),
});

type RouteContext = { params: Promise<{ board: string; date: string; id: string }> };

/** Cancel keeps the row. Any day that is not today has no route. */
export async function DELETE(request: Request, context: RouteContext) {
  let board: "caja" | "cocina";
  let date: string;
  let id: string;
  try {
    const parsed = paramsSchema.parse(await context.params);
    board = parsed.board;
    date = parsed.date;
    id = parsed.id;
  } catch {
    return NextResponse.json({ error: "BAD_DATE" }, { status: 400, headers: NO_STORE });
  }
  if (date !== chicagoToday()) {
    return NextResponse.json({ error: "NOT_TODAY" }, { status: 404, headers: NO_STORE });
  }
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    await cancelOverlay({
      manager: { id: auth.manager.id, name: auth.manager.name },
      board,
      date,
      id,
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof OverlayRefused) {
      const status = error.code === "NOT_TODAY" ? 404 : 422;
      return NextResponse.json({ error: error.code }, { status, headers: NO_STORE });
    }
    throw error;
  }
}
