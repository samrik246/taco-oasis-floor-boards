import { NextResponse } from "next/server";
import { z } from "zod";
import { MOVE_REASONS } from "@/lib/position-moves";
import {
  listPositionMoves,
  logPositionMove,
} from "@/lib/position-moves-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get("date");
    if (!date) {
      return NextResponse.json({ error: "date required" }, { status: 422 });
    }
    const logs = await listPositionMoves(date);
    return NextResponse.json({ logs, reasons: MOVE_REASONS });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to load moves" }, { status: 500 });
  }
}

const postSchema = z.object({
  date: z.string().min(1),
  hour: z.number().int(),
  employeeId: z.string().min(1),
  fromStationId: z.string().nullable().optional(),
  toStationId: z.string().nullable().optional(),
  assignmentId: z.string().nullable().optional(),
  reason: z.string().min(1),
  note: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const body = postSchema.parse(await req.json());
    const result = await logPositionMove({
      date: body.date,
      hour: body.hour,
      employeeId: body.employeeId,
      fromStationId: body.fromStationId ?? null,
      toStationId: body.toStationId ?? null,
      assignmentId: body.assignmentId,
      reason: body.reason,
      note: body.note,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ log: result.log });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    console.error(e);
    return NextResponse.json({ error: "Failed to log move" }, { status: 500 });
  }
}
