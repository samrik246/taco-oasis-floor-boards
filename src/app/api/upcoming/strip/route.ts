import { NextResponse } from "next/server";
import { chicagoToday, getUpcomingSource } from "@/lib/upcoming/source";

export const runtime = "nodejs";

/** T4G strip for cocina and caja. Same read as /api/upcoming, plus a sanitized first name. */
export async function GET() {
  const now = new Date();
  const snapshot = await getUpcomingSource().loadStrip(now);
  return NextResponse.json(
    { ...snapshot, today: chicagoToday(now) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
