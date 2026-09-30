import { NextResponse } from "next/server";
import { NO_STORE, requireDayAccess } from "@/lib/managers/day-access";
import { breaksNow } from "@/lib/breaks/now";
import { breakTimeline } from "@/lib/breaks/timeline";
import { chicagoToday } from "@/lib/upcoming/source";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const now = breaksNow();
  const date = new URL(request.url).searchParams.get("date") ?? chicagoToday(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Invalid date" }, { status: 400, headers: NO_STORE });
  const access = await requireDayAccess(request, date, now);
  if (!access.ok) return access.response;
  return NextResponse.json(await breakTimeline(date, now), { headers: NO_STORE });
}
