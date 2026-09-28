import type { Prisma } from "@prisma/client";

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
  /** Mandatory on/off only. The summary then ends in that word and omits count. */
  mark?: "on" | "off";
  /** Habilidades column hide. The summary then omits count. */
  columnHidden?: "hidden" | "shown";
  /** Habilidades column default. The summary then omits count. */
  columnDefault?: "ok" | "forbidden";
  /** Saved bien rows rewritten to no. The summary is station counts and no names. */
  abilityOkReset?: readonly { stationId: string; count: number }[];
  /** Chicago wall-clock HH:mm. With breakEnd, the summary is date, start and end. */
  breakStart?: string;
  /** Chicago wall-clock HH:mm. */
  breakEnd?: string;
  /** caja or cocina. The summary then includes board= and still includes count. */
  board?: "caja" | "cocina";
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
  abilities: "PUT /api/admin/abilities",
  abilityColumns: "PUT /api/admin/ability-columns",
  abilityColumnSeed: "script seed-ability-columns",
  mandatory: "PUT /api/admin/mandatory",
  agentPaint: "script agent-paint",
  breakSave: "break.save",
  breakClear: "break.clear",
  breakCodeCollision: "break.code-collision",
  breakImportDrop: "break.import-drop",
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
  if (parts.abilityOkReset) {
    for (const row of parts.abilityOkReset) {
      if (!/^[a-z0-9_]{1,32}$/.test(row.stationId)) continue;
      const count = Number.isInteger(row.count) && row.count >= 0 ? row.count : 0;
      bits.push(`${row.stationId}=${count}`);
    }
    return bits.join(" ");
  }
  if (parts.mark === "on" || parts.mark === "off") {
    bits.push(parts.mark);
    return bits.join(" ");
  }
  if (
    parts.breakStart &&
    parts.breakEnd &&
    /^\d{2}:\d{2}$/.test(parts.breakStart) &&
    /^\d{2}:\d{2}$/.test(parts.breakEnd)
  ) {
    bits.push(`start=${parts.breakStart}`, `end=${parts.breakEnd}`);
    return bits.join(" ");
  }
  if (parts.columnHidden || parts.columnDefault) {
    if (parts.columnHidden) bits.push(parts.columnHidden);
    if (parts.columnDefault) bits.push(`default=${parts.columnDefault}`);
    return bits.join(" ");
  }
  if (parts.board === "caja" || parts.board === "cocina") {
    bits.push(`board=${parts.board}`);
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

