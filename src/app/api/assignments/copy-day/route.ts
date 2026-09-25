import { NextResponse } from "next/server";
import { z } from "zod";
import { copyDayAssignments } from "@/lib/assignments/service";
import { requireManagerSession } from "@/lib/managers/require-session";

export const runtime = "nodejs";

const bodySchema = z.object({
  board: z.string().min(1),
  sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * POST /api/assignments/copy-day — Planner B, "Copiar ayer" / "Copiar semana
 * pasada". Manager mode only. Never overwrites an existing placement.
 */
export async function POST(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const json = await request.json();
    const body = bodySchema.parse(json);
    const result = await copyDayAssignments(body);
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
    const message = err instanceof Error ? err.message : "Copy failed";
    console.error("POST /api/assignments/copy-day", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
