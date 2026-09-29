import { NextResponse } from "next/server";
import { breaksNow, listBreaksNow } from "@/lib/breaks/now";
import { NO_STORE, requireDayAccess } from "@/lib/managers/day-access";
import { chicagoToday } from "@/lib/upcoming/source";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const board = url.searchParams.get("board");
  if (board !== "caja" && board !== "cocina") {
    return NextResponse.json({ error: "Esa área no tiene descansos." }, { status: 400, headers: NO_STORE });
  }
  const now = breaksNow();
  const access = await requireDayAccess(request, chicagoToday(now), now);
  if (!access.ok) return access.response;
  const body = await listBreaksNow(board, now);
  return NextResponse.json(body, { headers: NO_STORE });
}
