import { NextResponse } from "next/server";
import { z } from "zod";
import { managerIdleMsFromEnv } from "@/lib/managers/codes";
import { signInWithCode } from "@/lib/breaks/sign-in";
import { NO_STORE } from "@/lib/managers/day-access";

export const runtime = "nodejs";

/** Public config for client idle timer (no secrets). Always the shared setting, never a code's own timeout. */
export async function GET() {
  return NextResponse.json({ idleMs: managerIdleMsFromEnv() });
}

const bodySchema = z.object({
  code: z.string().trim().min(4).max(64),
});

/** Same collision and throttle rules as BREAK entry; floor access does not grant gerente power. */
export async function POST(request: Request) {
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400, headers: NO_STORE });
  const result = await signInWithCode("caja", body.data.code, new Date(), "floor");
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status, headers: NO_STORE });
  if (result.kind !== "manager" || !result.manager) return NextResponse.json({ ok: false, error: "Invalid manager code" }, { status: 401, headers: NO_STORE });
  return NextResponse.json({ ok: true, manager: result.manager, idleMs: result.idleMs, sessionToken: result.token }, { headers: NO_STORE });
}
