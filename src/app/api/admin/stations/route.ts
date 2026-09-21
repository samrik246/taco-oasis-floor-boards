import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { validateStationWrite, rejectManagerSecrets } from "@/lib/admin/validate";
import { requireManagerSession } from "@/lib/managers/require-session";
import { STATION_SHORT_CODES } from "@/lib/schedule/station-codes";

export const dynamic = "force-dynamic";

function presentShortCode(id: string, shortCode: string) {
  return shortCode || STATION_SHORT_CODES[id] || id.slice(0, 3).toUpperCase();
}

export async function GET(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  const stations = await prisma.station.findMany({
    orderBy: [{ board: "asc" }, { sortOrder: "asc" }],
  });
  return NextResponse.json({
    stations: stations.map((station) => ({
      id: station.id,
      board: station.board,
      label: station.label,
      color: station.color,
      shortCode: presentShortCode(station.id, station.shortCode),
      sortOrder: station.sortOrder,
      maxConcurrent: station.maxConcurrent,
    })),
  });
}

const createSchema = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string(),
  shortCode: z.string(),
  board: z.string(),
  sortOrder: z.number().optional(),
});

export async function POST(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = createSchema.parse(json);
    const existing = await prisma.station.findMany({
      select: { id: true, shortCode: true },
    });
    const checked = validateStationWrite(body, {
      id: body.id,
      creating: true,
      others: existing.map((row) => ({
        id: row.id,
        shortCode: presentShortCode(row.id, row.shortCode),
      })),
    });
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 422 });
    }
    const station = await prisma.station.create({
      data: {
        id: checked.value.id,
        label: checked.value.label,
        color: checked.value.color,
        shortCode: checked.value.shortCode,
        board: checked.value.board,
        sortOrder: checked.value.sortOrder,
        maxConcurrent: 1,
      },
    });
    return NextResponse.json({ station }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Station fields are required." }, { status: 422 });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to create station" }, { status: 500 });
  }
}
