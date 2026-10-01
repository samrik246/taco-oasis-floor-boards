import { legacyHttpGuard } from "@/lib/quarter/http";
import { requireDayAccess } from "@/lib/managers/day-access";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAssignment } from "@/lib/assignments/service";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
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
 * Returns 422 + violation codes on rule failure. Manager session required.
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
    const result = await createAssignment({
      ...body,
      actor: { id: auth.manager.id, name: auth.manager.name, route: BOARD_CHANGE_ROUTES.assign },
    });

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
