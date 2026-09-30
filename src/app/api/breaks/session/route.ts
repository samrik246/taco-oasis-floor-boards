import { NextResponse } from "next/server";
import { z } from "zod";
import { signInWithCode } from "@/lib/breaks/sign-in";
import { NO_STORE } from "@/lib/managers/day-access";

export const runtime = "nodejs";

const boardSchema = z.enum(["caja", "cocina"]);

/** Code only. The board comes from the tablet, never a name or an employee id. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ese código no coincide." }, { status: 401, headers: NO_STORE });
  }
  const record = body && typeof body === "object" ? body as { board?: unknown; code?: unknown } : {};
  const board = boardSchema.safeParse(record.board);
  if (!board.success) {
    return NextResponse.json({ error: "Esa área no tiene descansos." }, { status: 400, headers: NO_STORE });
  }
  const code = typeof record.code === "string" ? record.code : "";
  const result = await signInWithCode(board.data, code);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }
  return NextResponse.json({ token: result.token, name: result.name, kind: result.kind, staffToken: result.staffToken, idleMs: result.idleMs, role: result.role }, { headers: NO_STORE });
}
