import { NextResponse } from "next/server";
import { z } from "zod";
import { clearMyBreak, loadMyBreak, saveMyBreak } from "@/lib/breaks/mine";
import { BREAK_EXPIRED } from "@/lib/breaks/messages";
import { staffSessionFromRequest } from "@/lib/breaks/session";
import { NO_STORE } from "@/lib/managers/day-access";

export const runtime = "nodejs";

const postSchema = z.object({
  startAt: z.string().min(1),
  endAt: z.string().min(1),
});

function claimsOrExpired(request: Request) {
  const claims = staffSessionFromRequest(request);
  if (!claims) {
    return { ok: false as const, response: NextResponse.json({ error: BREAK_EXPIRED }, { status: 401, headers: NO_STORE }) };
  }
  return { ok: true as const, claims };
}

export async function GET(request: Request) {
  const auth = claimsOrExpired(request);
  if (!auth.ok) return auth.response;
  const body = await loadMyBreak(auth.claims);
  return NextResponse.json(body, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const auth = claimsOrExpired(request);
  if (!auth.ok) return auth.response;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Elige un cuarto de hora." }, { status: 400, headers: NO_STORE });
  }
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Elige un cuarto de hora." }, { status: 400, headers: NO_STORE });
  }
  const startAt = new Date(parsed.data.startAt);
  const endAt = new Date(parsed.data.endAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    return NextResponse.json({ error: "Elige un cuarto de hora." }, { status: 400, headers: NO_STORE });
  }
  const result = await saveMyBreak(auth.claims, startAt, endAt);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }
  return NextResponse.json({
    id: result.id,
    replaced: result.replaced,
    startAt: result.startAt,
    endAt: result.endAt,
    waiting: result.waiting,
    ...(result.waiting ? { message: result.message } : {}),
  }, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
  const auth = claimsOrExpired(request);
  if (!auth.ok) return auth.response;
  const result = await clearMyBreak(auth.claims);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }
  return NextResponse.json({ cleared: result.cleared }, { headers: NO_STORE });
}
