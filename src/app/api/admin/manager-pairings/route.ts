import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwnerSession } from "@/lib/managers/require-session";
import { NO_STORE } from "@/lib/managers/day-access";
import { pairManager, pairingData } from "@/lib/managers/pairing";

export const runtime = "nodejs";
const bodySchema = z.object({ managerId: z.string().min(1), employeeId: z.string().min(1).nullable(), confirm: z.literal(true) });

export async function GET(request: Request) {
  const auth = await requireOwnerSession(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json(await pairingData(), { headers: NO_STORE });
}

export async function PUT(request: Request) {
  const auth = await requireOwnerSession(request);
  if (!auth.ok) return auth.response;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Select and confirm a pairing" }, { status: 400, headers: NO_STORE });
  const result = await pairManager(auth.manager.id, body.data.managerId, body.data.employeeId);
  return NextResponse.json(result, { status: result.ok ? 200 : result.status, headers: NO_STORE });
}
