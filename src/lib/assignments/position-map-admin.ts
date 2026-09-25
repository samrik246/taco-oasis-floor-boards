import { prisma } from "@/lib/db";

export type PositionMapRow = {
  position: string;
  board: "caja" | "cocina" | null;
  /** false when this string's shifts are "other", or span both boards. */
  eligible: boolean;
  stationId: string | null;
};

/**
 * Every distinct When I Work position string on a non-superseded shift,
 * plus every existing map key (so a key whose shifts have since aged out
 * still shows its saved value). A position is only eligible for a dropdown
 * when its shifts sit on exactly one real board.
 */
export async function listPositionMapRows(): Promise<PositionMapRow[]> {
  const [shiftGroups, mapRows] = await Promise.all([
    prisma.shift.groupBy({
      by: ["sourcePosition", "board"],
      where: { supersededAt: null },
    }),
    prisma.positionStationMap.findMany(),
  ]);

  const boardsByPosition = new Map<string, Set<string>>();
  for (const g of shiftGroups) {
    const set = boardsByPosition.get(g.sourcePosition) ?? new Set<string>();
    set.add(g.board);
    boardsByPosition.set(g.sourcePosition, set);
  }
  const mapByPosition = new Map(mapRows.map((r) => [r.position, r.stationId]));
  const positions = new Set<string>([...boardsByPosition.keys(), ...mapByPosition.keys()]);

  const rows: PositionMapRow[] = [];
  for (const position of positions) {
    const boards = boardsByPosition.get(position) ?? new Set<string>();
    const singleRealBoard =
      boards.size === 1 && (boards.has("caja") || boards.has("cocina"))
        ? ([...boards][0] as "caja" | "cocina")
        : null;
    rows.push({
      position,
      board: singleRealBoard,
      eligible: singleRealBoard !== null,
      stationId: mapByPosition.get(position) ?? null,
    });
  }
  return rows.sort((a, b) => a.position.localeCompare(b.position));
}

export type SavePositionMapResult =
  | { ok: true }
  | { ok: false; status: 404 | 422; error: string };

/** stationId null clears the mapping (stores none). */
export async function savePositionMapRow(
  position: string,
  stationId: string | null,
): Promise<SavePositionMapResult> {
  if (stationId !== null) {
    const rows = await listPositionMapRows();
    const row = rows.find((r) => r.position === position);
    if (!row || !row.eligible) {
      return {
        ok: false,
        status: 422,
        error: "This position isn't on one board and can't be mapped",
      };
    }
    const station = await prisma.station.findUnique({ where: { id: stationId } });
    if (!station) {
      return { ok: false, status: 404, error: "Station not found" };
    }
    if (station.board !== row.board) {
      return { ok: false, status: 422, error: "That station is on the other board" };
    }
  }
  await prisma.positionStationMap.upsert({
    where: { position },
    create: { position, stationId },
    update: { stationId },
  });
  return { ok: true };
}
