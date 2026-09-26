import { NextResponse } from "next/server";
import { z } from "zod";
import { createAssignment } from "@/lib/assignments/service";
import { requireManagerSession } from "@/lib/managers/require-session";

export const runtime = "nodejs";

const bodySchema = z.object({
  shiftId: z.string().min(1),
  stationId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hour: z.number().int().min(0).max(23),
});

/**
 * PUT /api/assignments — create assignment with server-side rule validation.
 * Returns 422 + violation codes on rule failure.
 */
export async function PUT(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const json = await request.json();
    const body = bodySchema.parse(json);
    const result = await createAssignment(body);

    if (!result.ok) {
      return NextResponse.json(
        { error: "Assignment rejected", violations: result.violations },
        { status: result.status },
      );
    }

    return NextResponse.json({ assignment: result.assignment });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid body", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Assign failed";
    console.error("PUT /api/assignments", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
