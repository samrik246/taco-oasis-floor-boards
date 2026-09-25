import { NextResponse } from "next/server";
import { z } from "zod";
import { placeFixedAssignments } from "@/lib/assignments/fixed-assign";
import { requireManagerSession } from "@/lib/managers/require-session";

export const runtime = "nodejs";

const bodySchema = z.object({
  board: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * PUT /api/assignments/fixed — Planner G "Colocar fijos". Manager session
 * required, unlike the whole-shift and one-hour assign routes.
 */
export async function PUT(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const json = await request.json();
    const body = bodySchema.parse(json);
    const result = await placeFixedAssignments(body);
    return NextResponse.json({ summary: result.summary });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid body", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Colocar fijos failed";
    console.error("PUT /api/assignments/fixed", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
