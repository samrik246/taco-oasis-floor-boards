import { NextResponse } from "next/server";
import { z } from "zod";
import { loadAbilityGrid, setAbilityColumn } from "@/lib/abilities/store";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import { requireOwnerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  employeeId: z.string().min(1),
  column: z.string().min(1),
  level: z.enum(["forbidden", "training", "ok", "preferred"]),
});

/** Owner grid for cocina or caja. Any other board is refused. */
export async function GET(req: Request) {
  const auth = await requireOwnerSession(req);
  if (!auth.ok) return auth.response;
  const board = new URL(req.url).searchParams.get("board");
  if (board !== "cocina" && board !== "caja") {
    return NextResponse.json({ error: "Invalid board" }, { status: 400 });
  }
  const grid = await loadAbilityGrid(board);
  return NextResponse.json(grid);
}

/** One family or one station, one transaction, one change-log row. */
export async function PUT(req: Request) {
  const auth = await requireOwnerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const parsed = putSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const result = await setAbilityColumn({
      ...parsed.data,
      actor: {
        id: auth.manager.id,
        name: auth.manager.name,
        route: BOARD_CHANGE_ROUTES.abilities,
      },
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ written: result.written });
  } catch (error) {
    console.error("PUT /api/admin/abilities", error);
    return NextResponse.json({ error: "Could not save abilities" }, { status: 500 });
  }
}
