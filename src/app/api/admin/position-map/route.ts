import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  listPositionMapRows,
  savePositionMapRow,
} from "@/lib/assignments/position-map-admin";
import { rejectManagerSecrets } from "@/lib/admin/validate";
import { requireManagerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  const [rows, stations] = await Promise.all([
    listPositionMapRows(),
    prisma.station.findMany({
      orderBy: [{ board: "asc" }, { sortOrder: "asc" }],
      select: { id: true, board: true, label: true },
    }),
  ]);
  return NextResponse.json({ rows, stations });
}

const patchSchema = z.object({
  position: z.string().min(1),
  stationId: z.string().min(1).nullable(),
});

export async function PATCH(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = patchSchema.parse(json);
    const result = await savePositionMapRow(body.position, body.stationId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid body" }, { status: 422 });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to save position map" }, { status: 500 });
  }
}
