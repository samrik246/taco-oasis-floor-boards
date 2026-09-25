import { NextResponse } from "next/server";
import { z } from "zod";
import { clearAssignment } from "@/lib/assignments/service";
import { requireManagerSession } from "@/lib/managers/require-session";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  reason: z.string().optional(),
  note: z.string().nullable().optional(),
});

/**
 * DELETE /api/assignments/:id — clear an assignment. A future hour needs no
 * body. The current hour or a past hour needs { reason } and writes the
 * PositionMoveLog row in the same transaction as the delete (Planner E).
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }
    const raw = await request.text();
    const body = raw ? bodySchema.parse(JSON.parse(raw)) : {};
    const result = await clearAssignment({
      id,
      reason: body.reason,
      note: body.note,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json({ deleted: result.id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid body", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Clear failed";
    console.error("DELETE /api/assignments/[id]", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
