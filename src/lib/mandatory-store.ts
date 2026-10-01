import { boardWrite } from "@/lib/shared-write";
import { prisma } from "@/lib/db";
import { writeBoardChange, type BoardChangeActor } from "@/lib/board-change-log";
import { isDefaultMandatory, MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(ymd: string): boolean {
  if (!DATE_RE.test(ymd)) return false;
  const [year, month, day] = ymd.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export async function loadMandatoryDay(
  board: "caja" | "cocina",
  date: string,
  canMark: boolean,
) {
  const standing = MANDATORY_STATIONS_BY_BOARD[board];
  const marks = await prisma.mandatoryMark.findMany({
    where: { board, date },
    select: { stationId: true },
    orderBy: { stationId: "asc" },
  });
  const extraStationIds = marks
    .map((mark) => mark.stationId)
    .filter((stationId) => !isDefaultMandatory(stationId));
  return {
    stationIds: [...standing, ...extraStationIds],
    extraStationIds,
    canMark,
  };
}

export async function setMandatoryMark(input: {
  date: string;
  stationId: string;
  on: boolean;
  actor: BoardChangeActor;
}): Promise<{ ok: true; changed: boolean } | { ok: false; status: 400; error: string }> {
  if (!isRealDate(input.date)) return { ok: false, status: 400, error: "Invalid date" };
  if (isDefaultMandatory(input.stationId)) {
    return { ok: false, status: 400, error: "That station is already mandatory" };
  }
  return boardWrite(prisma, async tx => {
  const station = await tx.station.findUnique({
    where: { id: input.stationId },
    select: { id: true, board: true },
  });
  if (!station || (station.board !== "caja" && station.board !== "cocina")) {
    return { ok: false, status: 400, error: "Invalid station" };
  }
  const board = station.board;

  const where = {
    board_date_stationId: { board, date: input.date, stationId: input.stationId },
  };
  const existing = await tx.mandatoryMark.findUnique({ where, select: { id: true } });
  if (input.on === Boolean(existing)) return { ok: true, changed: false };

    if (input.on) {
      await tx.mandatoryMark.create({
        data: {
          board,
          date: input.date,
          stationId: input.stationId,
          managerId: input.actor.id,
        },
      });
    } else {
      await tx.mandatoryMark.delete({ where });
    }
    await writeBoardChange(tx, input.actor, {
      date: input.date,
      stationId: input.stationId,
      count: 1,
      mark: input.on ? "on" : "off",
    });
  return { ok: true, changed: true };
  });
}
