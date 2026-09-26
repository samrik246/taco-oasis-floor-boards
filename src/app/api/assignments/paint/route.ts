import { NextResponse } from "next/server";
import { z } from "zod";
import { paintAssignments } from "@/lib/assignments/paint";
import { requireManagerSession } from "@/lib/managers/require-session";
import { HOUR_GRID_END, HOUR_GRID_START } from "@/lib/constants";

export const runtime = "nodejs";

const editSchema = z.object({
  shiftId: z.string().min(1),
  hour: z.number().int().min(HOUR_GRID_START).max(HOUR_GRID_END - 1),
  expectedShift: z.object({
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    employeeId: z.string().min(1),
    sourcePosition: z.string(),
  }),
  expected: z.object({ id: z.string().min(1), stationId: z.string().min(1) }).nullable(),
  stationId: z.string().min(1).nullable(),
  reason: z.string().optional(),
  note: z.string().nullable().optional(),
});

const bodySchema = z.object({
  board: z.enum(["caja", "cocina"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  edits: z.array(editSchema).min(1).max(500),
});

/** Manager-only atomic save of painted one-hour cells. */
export async function PUT(request: Request) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const body = bodySchema.parse(await request.json());
    const result = await paintAssignments(body);
    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, error: result.message, violations: result.violations },
        { status: result.status },
      );
    }
    return NextResponse.json({ saved: result.saved });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid painted cells", details: error.issues }, { status: 400 });
    }
    console.error("PUT /api/assignments/paint", error);
    return NextResponse.json({ error: "Could not save painted cells" }, { status: 500 });
  }
}
