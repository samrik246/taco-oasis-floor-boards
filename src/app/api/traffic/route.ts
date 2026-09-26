import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getTrafficState,
  setTrafficEnabled,
} from "@/lib/traffic/service";
import { isFloorBoardId } from "@/lib/board-config";
import { requireManagerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

/** The training simulator is dormant; reads never advance its fake meters. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const boardRaw = url.searchParams.get("board");
    const board =
      boardRaw && isFloorBoardId(boardRaw) ? boardRaw : undefined;
    return NextResponse.json(await getTrafficState(board));
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to load traffic state" },
      { status: 500 },
    );
  }
}

const patchSchema = z.object({
  enabled: z.boolean(),
  date: z.string().optional(),
  hour: z.number().int().optional(),
  board: z.enum(["caja", "cocina"]).optional(),
});

/** Retain an off switch for recovery, but do not allow the dormant simulator on. */
export async function PATCH(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const body = patchSchema.parse(await req.json());
    if (body.enabled) {
      return NextResponse.json({ error: "Training traffic is unavailable" }, { status: 410 });
    }
    const state = await setTrafficEnabled(body.enabled, body.board);
    return NextResponse.json(state);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return NextResponse.json(
      { error: "Failed to update traffic simulator" },
      { status: 500 },
    );
  }
}
