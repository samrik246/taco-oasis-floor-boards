import { NextResponse } from "next/server";
import { chicagoToday, getUpcomingSource } from "@/lib/upcoming/source";

export const runtime = "nodejs";

/** Upcoming Tacos4Groups orders for SQUARE NEXT. Kitchen fields only (23A). */
export async function GET() {
  const now = new Date();
  const snapshot = await getUpcomingSource().load(now);
  return NextResponse.json(
    { ...snapshot, today: chicagoToday(now) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
