import { prisma } from "@/lib/db";
import { writeBoardChange, type BoardChangeActor } from "@/lib/board-change-log";
import { isValidMoveReason, type MoveReason } from "@/lib/position-moves";

export type LogMoveParams = {
  date: string;
  hour: number;
  employeeId: string;
  fromStationId: string | null;
  toStationId: string | null;
  assignmentId?: string | null;
  reason: string;
  note?: string | null;
  actor?: BoardChangeActor;
};

export async function logPositionMove(params: LogMoveParams) {
  if (!isValidMoveReason(params.reason)) {
    return {
      ok: false as const,
      status: 422 as const,
      error: `Invalid reason. Use: Break, Cover expo, Training, Help slammed, Other`,
    };
  }
  const employee = await prisma.employee.findUnique({
    where: { id: params.employeeId },
  });
  if (!employee) {
    return { ok: false as const, status: 404 as const, error: "Employee not found" };
  }

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.positionMoveLog.create({
      data: {
        date: params.date,
        hour: params.hour,
        employeeId: params.employeeId,
        fromStationId: params.fromStationId,
        toStationId: params.toStationId,
        assignmentId: params.assignmentId ?? null,
        reason: params.reason as MoveReason,
        note: params.note?.trim() || null,
      },
    });
    if (params.actor) {
      await writeBoardChange(tx, params.actor, {
        date: params.date,
        hour: params.hour,
        stationId: params.toStationId ?? params.fromStationId,
        count: 1,
      });
    }
    return created;
  });
  return { ok: true as const, log: row };
}

export async function listPositionMoves(date: string) {
  return prisma.positionMoveLog.findMany({
    where: { date },
    include: {
      employee: {
        select: { id: true, firstName: true, lastName: true, externalId: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}
