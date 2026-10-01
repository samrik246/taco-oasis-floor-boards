import { legacyHttpGuard } from "@/lib/quarter/http";
import { requireDayAccess } from "@/lib/managers/day-access";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  freeFavoriteFor,
  freeFavoritesForHour,
  suggestAssign,
} from "@/lib/assignments/suggest";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { requireManagerSession } from "@/lib/managers/require-session";

export const runtime = "nodejs";

const querySchema = z.object({
  board: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hour: z.coerce.number().int().min(0).max(23),
  stationId: z.string().min(1).optional(),
});

/**
 * GET /api/assignments/suggest — Planner I chip candidate(s). Manager
 * session required, matching the chip's own visibility rule. With
 * `stationId`, one candidate; without it, every station on the board in one
 * request — the floor calls this form once per hour/date/board change
 * instead of once per empty station tile.
 */
export async function GET(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  const upgrade = await legacyHttpGuard();
  if (upgrade) return upgrade;
  try {
    const url = new URL(request.url);
    const params = querySchema.parse({
      board: url.searchParams.get("board"),
      date: url.searchParams.get("date"),
      hour: url.searchParams.get("hour"),
      stationId: url.searchParams.get("stationId") ?? undefined,
    });
    const dayAccess = await requireDayAccess(request, params.date);
    if (!dayAccess.ok) return dayAccess.response;
    if (!params.stationId) {
      const candidates = await freeFavoritesForHour(params);
      return NextResponse.json({ candidates });
    }
    const candidate = await freeFavoriteFor({ ...params, stationId: params.stationId });
    return NextResponse.json({ candidate });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid query", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Suggest lookup failed";
    console.error("GET /api/assignments/suggest", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

const bodySchema = z.object({
  board: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hour: z.number().int().min(0).max(23),
  stationId: z.string().min(1),
  shiftId: z.string().min(1),
});

/**
 * PUT /api/assignments/suggest — Planner I chip tap. Rechecks the free
 * favorite server-side before writing.
 */
export async function PUT(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  const upgrade = await legacyHttpGuard();
  if (upgrade) return upgrade;
  try {
    const json = await request.json();
    const body = bodySchema.parse(json);
    const dayAccess = await requireDayAccess(request, body.date);
    if (!dayAccess.ok) return dayAccess.response;
    const result = await suggestAssign({
      ...body,
      actor: { id: auth.manager.id, name: auth.manager.name, route: BOARD_CHANGE_ROUTES.suggest },
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ summary: result.summary });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid body", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Suggest assign failed";
    console.error("PUT /api/assignments/suggest", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
