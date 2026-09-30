import { NextResponse } from "next/server";
import { chicagoToday } from "@/lib/upcoming/source";
import { loadRegular } from "@/lib/regular/source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** C3 regular orders for the Regulares page. Same access as /api/upcoming: no auth, no-store. */
export async function GET() {
  const now = new Date();
  const snapshot = await loadRegular(now);
  return NextResponse.json(
    { ...snapshot, today: chicagoToday(now) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
