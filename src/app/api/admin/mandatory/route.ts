import { NextResponse } from "next/server";
import { z } from "zod";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { setMandatoryMark } from "@/lib/mandatory-store";
import { requireOwnerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stationId: z.string().min(1),
  on: z.boolean(),
});

/** Owner-only one-day mandatory mark. Standing stations are not accepted. */
export async function PUT(req: Request) {
  const auth = await requireOwnerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const parsed = putSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const result = await setMandatoryMark({
      ...parsed.data,
      actor: {
        id: auth.manager.id,
        name: auth.manager.name,
        route: BOARD_CHANGE_ROUTES.mandatory,
      },
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ changed: result.changed });
  } catch (error) {
    console.error("PUT /api/admin/mandatory", error);
    return NextResponse.json({ error: "Could not save the mark" }, { status: 500 });
  }
}
