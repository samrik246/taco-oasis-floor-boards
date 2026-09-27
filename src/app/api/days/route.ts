import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { NO_STORE, optionalManager } from "@/lib/managers/day-access";
import { chicagoToday } from "@/lib/upcoming/source";

export const runtime = "nodejs";

/**
 * Dates that have at least one shift in the DB. A manager gets every date;
 * staff get today only (the server's Chicago date), so planned days stay hidden.
 */
export async function GET(request: Request) {
  const rows = await prisma.shift.findMany({
    select: { date: true },
    distinct: ["date"],
    orderBy: { date: "asc" },
  });
  const dates = rows.map((r) => r.date);
  const manager = await optionalManager(request);
  const today = chicagoToday();
  return NextResponse.json(
    { dates: manager ? dates : dates.filter((d) => d === today) },
    { headers: NO_STORE },
  );
}
