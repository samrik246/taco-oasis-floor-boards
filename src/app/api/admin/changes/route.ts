import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireOwnerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

type ChangeRow = {
  id: string;
  createdAt: string;
  who: string;
  what: string;
  date: string;
  kind: "change" | "removal";
};

/** Owner screen: board writes and shift-removal events, newest first. */
export async function GET(req: Request) {
  const auth = await requireOwnerSession(req);
  if (!auth.ok) return auth.response;
  const date = new URL(req.url).searchParams.get("date");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Invalid date" }, { status: 422 });
  }

  const [changes, removals] = await Promise.all([
    prisma.boardChangeLog.findMany({
      where: date ? { date } : undefined,
      orderBy: { createdAt: "desc" },
    }),
    prisma.shiftRemovalEvent.findMany({
      where: date ? { override: { date } } : undefined,
      include: { override: { select: { date: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const rows: ChangeRow[] = [
    ...changes.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      who: row.managerName,
      what: row.summary,
      date: row.date,
      kind: "change" as const,
    })),
    ...removals.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      who: row.managerName ?? "",
      what: `removal ${row.action} ${row.override.date}`,
      date: row.override.date,
      kind: "removal" as const,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  return NextResponse.json({ changes: rows });
}
