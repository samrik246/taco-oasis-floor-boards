import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** Dates that have at least one shift in the DB. */
export async function GET() {
  const rows = await prisma.shift.findMany({
    select: { date: true },
    distinct: ["date"],
    orderBy: { date: "asc" },
  });
  return NextResponse.json({ dates: rows.map((r) => r.date) });
}
