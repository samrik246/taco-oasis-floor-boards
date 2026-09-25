import { NextResponse } from "next/server";
import { z } from "zod";
import { createShiftAssignment } from "@/lib/assignments/service";

export const runtime = "nodejs";

const bodySchema = z.object({
  shiftId: z.string().min(1),
  stationId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * PUT /api/assignments/shift — Planner A whole-shift assign. Places every
 * grid hour the shift overlaps at one station in one request; occupied or
 * already-seated hours are skipped, not failed. Same auth posture as
 * PUT /api/assignments — no manager token required.
 */
export async function PUT(request: Request) {
  try {
    const json = await request.json();
    const body = bodySchema.parse(json);
    const result = await createShiftAssignment(body);

    if (!result.ok) {
      return NextResponse.json(
        { error: "Shift assign rejected", violations: result.violations },
        { status: result.status },
      );
    }

    return NextResponse.json({ summary: result.summary });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid body", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Shift assign failed";
    console.error("PUT /api/assignments/shift", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
