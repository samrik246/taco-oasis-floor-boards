import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type BoardChangeActor = {
  id: string;
  name: string;
  route: string;
};

export type BoardChangeParts = {
  date: string;
  hour?: number | null;
  stationId?: string | null;
  count: number;
};

export const BOARD_CHANGE_ROUTES = {
  assign: "PUT /api/assignments",
  suggest: "PUT /api/assignments/suggest",
  paint: "PUT /api/assignments/paint",
  shift: "PUT /api/assignments/shift",
  fixed: "PUT /api/assignments/fixed",
  swap: "POST /api/assignments/swap",
  copyDay: "POST /api/assignments/copy-day",
  clear: "DELETE /api/assignments/[id]",
  positionMove: "POST /api/position-moves",
} as const;

/** Day, hour, station, count. Request prose never reaches this line. */
export function boardChangeSummary(parts: BoardChangeParts): string {
  const bits = [/^\d{4}-\d{2}-\d{2}$/.test(parts.date) ? parts.date : "undated"];
  if (
    typeof parts.hour === "number" &&
    Number.isInteger(parts.hour) &&
    parts.hour >= 0 &&
    parts.hour <= 23
  ) {
    bits.push(`hour=${parts.hour}`);
  }
  if (parts.stationId && /^[A-Za-z0-9_,.-]{1,80}$/.test(parts.stationId)) {
    bits.push(`station=${parts.stationId}`);
  }
  const count = Number.isInteger(parts.count) && parts.count >= 0 ? parts.count : 0;
  bits.push(`count=${count}`);
  return bits.join(" ");
}

export async function writeBoardChange(
  tx: Prisma.TransactionClient,
  actor: BoardChangeActor,
  parts: BoardChangeParts,
): Promise<void> {
  await tx.boardChangeLog.create({
    data: {
      managerId: actor.id,
      managerName: actor.name,
      route: actor.route,
      date: /^\d{4}-\d{2}-\d{2}$/.test(parts.date) ? parts.date : "undated",
      summary: boardChangeSummary(parts),
    },
  });
}

/**
 * Fan-out routes (whole shift, suggest, fijos, copy-day) commit one log row
 * only after the call has already returned success. A refusal returns first,
 * so it inserts nothing. Single-write routes call `writeBoardChange` inside
 * the write's own transaction instead.
 */
export async function commitBoardChange(
  actor: BoardChangeActor,
  parts: BoardChangeParts,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await writeBoardChange(tx, actor, parts);
  });
}
