import { NextResponse } from "next/server";
import { z } from "zod";
import { freeFavoriteFor, suggestAssign } from "@/lib/assignments/suggest";
import { requireManagerSession } from "@/lib/managers/require-session";

export const runtime = "nodejs";

const querySchema = z.object({
  board: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hour: z.coerce.number().int().min(0).max(23),
  stationId: z.string().min(1),
});

/**
 * GET /api/assignments/suggest — Planner I chip candidate. Manager session
 * required, matching the chip's own visibility rule.
 */
export async function GET(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(request.url);
    const params = querySchema.parse({
      board: url.searchParams.get("board"),
      date: url.searchParams.get("date"),
      hour: url.searchParams.get("hour"),
      stationId: url.searchParams.get("stationId"),
    });
    const candidate = await freeFavoriteFor(params);
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
  try {
    const json = await request.json();
    const body = bodySchema.parse(json);
    const result = await suggestAssign(body);
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
