import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  managerIdleMsFromEnv,
  verifyManagerCodeHash,
} from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";

export const runtime = "nodejs";

/** Public config for client idle timer (no secrets). */
export async function GET() {
  return NextResponse.json({ idleMs: managerIdleMsFromEnv() });
}

const bodySchema = z.object({
  code: z.string().min(1).max(32),
});

/** Verify a manager access code. Never returns hashes or plaintext codes. */
export async function POST(request: Request) {
  try {
    const json = await request.json();
    const { code } = bodySchema.parse(json);

    const managers = await prisma.manager.findMany({
      where: { active: true },
      select: { id: true, name: true, codeHash: true },
    });

    const match = managers.find((m) =>
      verifyManagerCodeHash(code, m.codeHash),
    );

    if (!match) {
      return NextResponse.json(
        { ok: false, error: "Invalid manager code" },
        { status: 401 },
      );
    }

    return NextResponse.json({
      ok: true,
      manager: { id: match.id, name: match.name },
      idleMs: managerIdleMsFromEnv(),
      sessionToken: signManagerSession({ id: match.id, name: match.name }),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: "Invalid request" },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Bad request";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
