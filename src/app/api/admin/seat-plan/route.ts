import { NextResponse } from "next/server";
import { z } from "zod";
import { createAssignment, deleteAssignment } from "@/lib/assignments/service";
import { seatRejection, rejectManagerSecrets } from "@/lib/admin/validate";
import { requireManagerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  shiftId: z.string().min(1),
  stationId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hour: z.number().int(),
});

/** Seat someone. Same one-person-per-station rules as the floor. */
export async function POST(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = postSchema.parse(json);
    const result = await createAssignment(body);
    if (!result.ok) {
      return NextResponse.json(
        { error: seatRejection(result.violations), violations: result.violations },
        { status: result.status },
      );
    }
    return NextResponse.json({ assignment: result.assignment }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Seat plan needs a person, station, date, and hour." },
        { status: 422 },
      );
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to seat" }, { status: 500 });
  }
}

const deleteSchema = z.object({
  assignmentId: z.string().min(1),
});

export async function DELETE(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = deleteSchema.parse(json);
    const result = await deleteAssignment(body.assignmentId);
    if (!result.ok) {
      return NextResponse.json(
        { error: seatRejection(result.violations), violations: result.violations },
        { status: result.status },
      );
    }
    return NextResponse.json({ deleted: result.id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Assignment id is required." }, { status: 422 });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to clear seat" }, { status: 500 });
  }
}
