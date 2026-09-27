import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  managerSessionFromRequest,
  managerSessionIsConfigured,
} from "@/lib/managers/session";
import { isOwnerRole } from "@/lib/managers/roles";

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
  if (!managerSessionIsConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Manager access is not configured" },
        { status: 503 },
      ),
    };
  }
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

/**
 * Owner routes. Role is read from the database on this request, never from the token.
 * A stored role other than the exact string owner is 403.
 */
export async function requireOwnerSession(
  req: Request,
): Promise<
  | { ok: true; manager: AuthedManager }
  | { ok: false; response: NextResponse }
> {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth;
  const row = await prisma.manager.findFirst({
    where: { id: auth.manager.id, active: true },
    select: { role: true },
  });
  if (!row || !isOwnerRole(row.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Owner code required" },
        { status: 403 },
      ),
    };
  }
  return auth;
}
