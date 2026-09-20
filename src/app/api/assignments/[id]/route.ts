import { NextResponse } from "next/server";
import { deleteAssignment } from "@/lib/assignments/service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/assignments/:id — clear an assignment.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }
    const result = await deleteAssignment(id);
    if (!result.ok) {
      return NextResponse.json(
        { error: "Clear rejected", violations: result.violations },
        { status: result.status },
      );
    }
    return NextResponse.json({ deleted: result.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Clear failed";
    console.error("DELETE /api/assignments/[id]", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
