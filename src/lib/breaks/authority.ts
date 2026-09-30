import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireManagerSession } from "@/lib/managers/require-session";
import { NO_STORE } from "@/lib/managers/day-access";
import { chicagoToday } from "@/lib/upcoming/source";

export const GERENTE_POSITIONS = ["Caja Manager", "Cocina Guia Abrir", "Cocina Guia Cerrar"] as const;

/** Read the current row and schedule every time; tokens, paint and Switch grant no power. */
export async function gerenteAuthority(id: string, now = new Date(), db: Prisma.TransactionClient = prisma) {
  const manager = await db.manager.findFirst({
    where: { id, active: true },
    select: { id: true, name: true, role: true, employeeId: true },
  });
  if (!manager) return null;
  if (manager.role === "owner") return manager;
  if (!manager.employeeId) return null;
  const shift = await db.shift.findFirst({
    where: {
      employeeId: manager.employeeId, date: chicagoToday(now),
      sourcePosition: { in: [...GERENTE_POSITIONS] },
      board: { in: ["caja", "cocina"] },
      supersededAt: null, boardRemoved: false, endAt: { gt: now },
    }, select: { id: true },
  });
  return shift ? manager : null;
}

export async function requireGerenteSession(request: Request, now = new Date()) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth;
  const manager = await gerenteAuthority(auth.manager.id, now);
  if (!manager) return {
    ok: false as const,
    response: NextResponse.json({ error: "Gerente access required" }, { status: 403, headers: NO_STORE }),
  };
  return { ok: true as const, manager };
}
