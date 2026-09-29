/**
 * One-time colour rename for stations still on the 2374986 seed colour.
 * A manager colour (any other value) is left alone. A second run updates nothing.
 * The write sets `color` only. It does not insert a row.
 *
 * `from` is the colour name in prisma/seed at main 2374986.
 * Stations whose name did not change are absent: their paint changed in the maps.
 */

export type StationColourMove = { id: string; from: string; to: string };

export const S14_COLOUR_MOVES: readonly StationColourMove[] = [
  { id: "mana", from: "pink", to: "white" },
  { id: "green1", from: "green", to: "light-green" },
  { id: "yellow2", from: "yellow", to: "gold" },
  { id: "green2", from: "lime", to: "dark-green" },
  { id: "purple2", from: "lavender", to: "violet" },
  { id: "nieves", from: "teal", to: "light-pink" },
  { id: "nieves2", from: "teal", to: "dark-pink" },
  { id: "clean", from: "cyan", to: "gray-blue" },
  { id: "pdf_br2a", from: "orange", to: "brown" },
  { id: "pdf_crne", from: "brown", to: "light-orange" },
  { id: "pdf_pr3e", from: "green", to: "dark-green" },
  { id: "pdf_rlno", from: "lime", to: "deep-orange" },
  { id: "pdf_tsr2", from: "gray", to: "sky" },
  { id: "pdf_guia", from: "orange", to: "white" },
  { id: "pdf_pr1e", from: "lime", to: "light-green" },
  { id: "pdf_tq1r", from: "pink", to: "light-red" },
  { id: "pdf_tf2r", from: "yellow", to: "gold" },
  { id: "pdf_br1a", from: "brown", to: "light-brown" },
  { id: "pdf_tsrea", from: "gray", to: "light-sky" },
  { id: "pdf_tsr3", from: "gray", to: "dark-sky" },
  { id: "pdf_tsr4", from: "gray", to: "deep-sky" },
];

export type StationColourRow = { id: string; color: string };

export type StationColourStore = {
  station: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; color: true };
    }): Promise<StationColourRow[]>;
    updateMany(args: {
      where: { id: string; color: string };
      data: { color: string };
    }): Promise<{ count: number }>;
  };
};

export type StationColourCounts = {
  before: number;
  updated: number;
  kept: number;
  already: number;
  missing: number;
  after: number;
};

export async function applyS14StationColours(db: StationColourStore): Promise<StationColourCounts> {
  const ids = S14_COLOUR_MOVES.map((move) => move.id);
  const select = { id: true, color: true } as const;
  const beforeRows = await db.station.findMany({ where: { id: { in: ids } }, select });
  const byId = new Map(beforeRows.map((row) => [row.id, row.color]));

  let before = 0;
  let updated = 0;
  let kept = 0;
  let already = 0;
  let missing = 0;

  for (const move of S14_COLOUR_MOVES) {
    const current = byId.get(move.id);
    if (current === undefined) {
      missing += 1;
      continue;
    }
    if (current === move.from) before += 1;
    if (current === move.to) {
      already += 1;
      continue;
    }
    if (current !== move.from) {
      kept += 1;
      continue;
    }
    const result = await db.station.updateMany({
      where: { id: move.id, color: move.from },
      data: { color: move.to },
    });
    updated += result.count;
    if (result.count === 1) byId.set(move.id, move.to);
  }

  let after = 0;
  for (const move of S14_COLOUR_MOVES) {
    if (byId.get(move.id) === move.from) after += 1;
  }

  return { before, updated, kept, already, missing, after };
}

export function formatS14StationColourCounts(counts: StationColourCounts): string {
  return [
    "s14 station colours",
    `before: ${counts.before}`,
    `updated: ${counts.updated}`,
    `kept: ${counts.kept}`,
    `already: ${counts.already}`,
    `missing: ${counts.missing}`,
    `after: ${counts.after}`,
  ].join("\n");
}
