import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { managerSessionFromRequest } from "@/lib/managers/session";

export type AuthedManager = { id: string; name: string };

/**
 * Privileged floor and back-office routes.
 * The token is an HMAC of id+name+expiry — never a plaintext access code.
 */
export async function requireManagerSession(
  req: Request,
): Promise<
  | { ok: true; manager: AuthedManager }
  | { ok: false; response: NextResponse }
> {
  const claims = managerSessionFromRequest(req);
  if (!claims) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Manager code required" },
        { status: 401 },
      ),
    };
  }

  const manager = await prisma.manager.findFirst({
    where: { id: claims.id, active: true },
    select: { id: true, name: true },
  });
  if (!manager) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Manager code required" },
        { status: 401 },
      ),
    };
  }

  return { ok: true, manager };
}
