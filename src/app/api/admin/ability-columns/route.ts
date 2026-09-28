import { NextResponse } from "next/server";
import { z } from "zod";
import { setAbilityColumnSetting } from "@/lib/abilities/column-settings";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { requireOwnerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  key: z.string().min(1),
  hidden: z.boolean().optional(),
  defaultLevel: z.enum(["ok", "forbidden"]).optional(),
}).refine((body) => body.hidden != null || body.defaultLevel != null, {
  message: "Nothing to save",
});

/** Owner-only column hide and Nuevos default. A manager session is refused. */
export async function PUT(req: Request) {
  const auth = await requireOwnerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const parsed = putSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const result = await setAbilityColumnSetting({
      ...parsed.data,
      actor: {
        id: auth.manager.id,
        name: auth.manager.name,
        route: BOARD_CHANGE_ROUTES.abilityColumns,
      },
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ changed: result.changed });
  } catch (error) {
    console.error("PUT /api/admin/ability-columns", error);
    return NextResponse.json({ error: "Could not save the column" }, { status: 500 });
  }
}
