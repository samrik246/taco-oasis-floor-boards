import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { validateStationWrite, rejectManagerSecrets } from "@/lib/admin/validate";
import { requireManagerSession } from "@/lib/managers/require-session";
import { STATION_SHORT_CODES } from "@/lib/schedule/station-codes";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  label: z.string(),
  color: z.string(),
  shortCode: z.string(),
  board: z.string(),
  sortOrder: z.number().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, context: RouteContext) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await context.params;
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = patchSchema.parse(json);
    const existing = await prisma.station.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Station not found." }, { status: 404 });
    }
    const others = await prisma.station.findMany({
      select: { id: true, shortCode: true },
    });
    const checked = validateStationWrite(body, {
      id,
      creating: false,
      others: others.map((row) => ({
        id: row.id,
        shortCode:
          row.shortCode ||
          STATION_SHORT_CODES[row.id] ||
          row.id.slice(0, 3).toUpperCase(),
      })),
    });
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 422 });
    }
    const station = await prisma.station.update({
      where: { id },
      data: {
        label: checked.value.label,
        color: checked.value.color,
        shortCode: checked.value.shortCode,
        board: checked.value.board,
        sortOrder: checked.value.sortOrder,
      },
    });
    return NextResponse.json({
      station: {
        id: station.id,
        board: station.board,
        label: station.label,
        color: station.color,
        shortCode: station.shortCode,
        sortOrder: station.sortOrder,
        maxConcurrent: station.maxConcurrent,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Station fields are required." }, { status: 422 });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to update station" }, { status: 500 });
  }
}
