import { NextResponse } from "next/server";
import { z } from "zod";
import { toggleFavorite } from "@/lib/abilities/favorite";
import { requireManagerSession } from "@/lib/managers/require-session";

export const runtime = "nodejs";

const bodySchema = z.object({
  employeeId: z.string().min(1),
  stationId: z.string().min(1),
});

/**
 * POST /api/abilities/favorite — Planner H. Manager session required, same
 * as copy-day and Colocar fijos.
 */
export async function POST(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const json = await request.json();
    const body = bodySchema.parse(json);
    const result = await toggleFavorite(body.employeeId, body.stationId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ level: result.level });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid body", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Toggle failed";
    console.error("POST /api/abilities/favorite", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
