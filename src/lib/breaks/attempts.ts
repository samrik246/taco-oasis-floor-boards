import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const WINDOW_MS = 15 * 60 * 1000;
const PAUSE_MS = 60 * 1000;

/** Sign-in reservations share this row so SQLite's write lock runs before any read of the attempt. */
const ATTEMPT_LOCK_ID = 2;

export async function reservePasscodeAttempt(
  board: "caja" | "cocina",
  now: Date = new Date(),
): Promise<"paused" | "reserved"> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.staffBreakLock.upsert({
      where: { id: ATTEMPT_LOCK_ID },
      create: { id: ATTEMPT_LOCK_ID },
      update: { updatedAt: now },
    });
    const row = await tx.staffPasscodeAttempt.findUnique({ where: { board } });
    if (row?.lockedUntil && row.lockedUntil.getTime() > now.getTime()) return "paused";
    const stale = !row || now.getTime() - row.windowStart.getTime() > WINDOW_MS;
    const failures = stale ? 1 : row.failures + 1;
    const windowStart = stale ? now : row.windowStart;
    const lockedUntil = failures >= 5 ? new Date(now.getTime() + PAUSE_MS) : null;
    await tx.staffPasscodeAttempt.upsert({
      where: { board },
      create: { board, failures, windowStart, lockedUntil },
      update: { failures, windowStart, lockedUntil },
    });
    return "reserved";
  });
}

export async function clearPasscodeAttempt(board: "caja" | "cocina", now: Date = new Date()): Promise<void> {
  await prisma.staffPasscodeAttempt.upsert({
    where: { board },
    create: { board, failures: 0, windowStart: now, lockedUntil: null },
    update: { failures: 0, windowStart: now, lockedUntil: null },
  });
}
