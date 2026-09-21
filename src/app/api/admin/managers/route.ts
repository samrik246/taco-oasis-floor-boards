import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireManagerSession } from "@/lib/managers/require-session";

export const dynamic = "force-dynamic";

/** Names and active flag only. Never returns codeHash or plaintext codes. */
export async function GET(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  const managers = await prisma.manager.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, active: true },
  });
  return NextResponse.json({ managers });
}
