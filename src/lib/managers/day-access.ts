import type { NextResponse } from "next/server";
import { chicagoToday } from "@/lib/upcoming/source";
import {
  requireManagerSession,
  type AuthedManager,
} from "@/lib/managers/require-session";

export type DayAccess =
  | { ok: true; manager: AuthedManager | null }
  | { ok: false; response: NextResponse };

/**
 * Staff see today's board only. Any other day (a planned future day or an
 * old one) needs a manager session. Today is the server's Chicago date, never
 * a date the client sends.
 */
export async function requireDayAccess(
  req: Request,
  date: string,
  now: Date = new Date(),
): Promise<DayAccess> {
  if (date === chicagoToday(now)) return { ok: true, manager: null };
  return requireManagerSession(req);
}

/** The active manager behind this request, or null for staff. Never an error. */
export async function optionalManager(
  req: Request,
): Promise<AuthedManager | null> {
  const auth = await requireManagerSession(req);
  return auth.ok ? auth.manager : null;
}

/** Payloads that differ by session or by day must not be cached for another viewer. */
export const NO_STORE = { "Cache-Control": "private, no-store" } as const;
