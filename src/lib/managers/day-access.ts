import { z } from "zod";
import type { NextResponse } from "next/server";
import { chicagoToday } from "@/lib/upcoming/source";
import {
  requireManagerSession,
  requireOwnerSession,
  type AuthedManager,
} from "@/lib/managers/require-session";

/** A real calendar date, before authorization or date arithmetic. */
export const boardDateSchema = z.iso.date();

export type DayAccess =
  | { ok: true; manager: AuthedManager | null }
  | { ok: false; response: NextResponse };

/**
 * Staff see today's board only. Any other day (a planned future day or an
 * old one) needs an owner session. Ordinary managers are today-only. Today is the server's Chicago date, never
 * a date the client sends.
 */
export async function requireDayAccess(
  req: Request,
  date: string,
  now: Date = new Date(),
): Promise<DayAccess> {
  if (date === chicagoToday(now)) return { ok: true, manager: null };
  return requireOwnerSession(req);
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

/** Validate persisted dates too: an id cannot bypass a caller's today-only date. */
export async function requireAssignmentDayAccess(req: Request, ids: string[]) {
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.assignment.findMany({ where: { id: { in: ids } }, select: { hourStart: true, shift: { select: { date: true } } } });
  for (const row of rows) {
    for (const date of [chicagoToday(row.hourStart), row.shift.date]) {
      const access = await requireDayAccess(req, date);
      if (!access.ok) return access;
    }
  }
  return { ok: true as const };
}
