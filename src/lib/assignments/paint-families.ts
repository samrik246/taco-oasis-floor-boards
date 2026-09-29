export const PAINT_FAMILIES = {
  green: ["green1", "green2"],
  purple: ["purple1", "purple2"],
  nieves: ["nieves", "nieves2"],
  yellow: ["yellow", "yellow2"],
  preparacion: ["pdf_pr1e", "pdf_pr2e", "pdf_pr3e"],
  tortillaFreidora: ["pdf_tf1r", "pdf_tf2r"],
  taquero: ["pdf_tq1r", "pdf_tq2r", "pdf_tq3r"],
  birria: ["pdf_br1a", "pdf_br2a"],
  trastes: ["pdf_tsrea", "pdf_tsr2", "pdf_tsr3", "pdf_tsr4"],
  carneRelleno: ["pdf_crne", "pdf_rlno", "pdf_cyrl"],
} as const;

export type PaintFamily = keyof typeof PAINT_FAMILIES;

export const PAINT_FAMILY_LABELS: Record<PaintFamily, string> = {
  green: "Green",
  purple: "Purple",
  nieves: "Nieves",
  yellow: "Yellow",
  preparacion: "Preparación",
  tortillaFreidora: "Tortilla Freidora",
  taquero: "Taquero",
  birria: "Birria",
  trastes: "Trastes",
  carneRelleno: "Carne y Relleno",
};

export function isPaintFamily(value: unknown): value is PaintFamily {
  return typeof value === "string" && Object.hasOwn(PAINT_FAMILIES, value);
}

export function familyForStation(stationId: string): PaintFamily | null {
  return (Object.keys(PAINT_FAMILIES) as PaintFamily[]).find((family) =>
    (PAINT_FAMILIES[family] as readonly string[]).includes(stationId),
  ) ?? null;
}

export type PaletteSlot =
  | { kind: "family"; family: PaintFamily }
  | { kind: "station"; id: string };

function completeFamilies(stationIds: ReadonlySet<string>): Set<PaintFamily> {
  return new Set(
    (Object.keys(PAINT_FAMILIES) as PaintFamily[]).filter((family) =>
      (PAINT_FAMILIES[family] as readonly string[]).every((id) => stationIds.has(id)),
    ),
  );
}

/**
 * One block per complete paint family, sitting where member 1 sits in board order.
 * Members follow family number order and appear once. An incomplete family stays put.
 */
export function groupStationsInBoardOrder(stationIds: readonly string[]): string[] {
  const complete = completeFamilies(new Set(stationIds));
  const emitted = new Set<string>();
  const grouped: string[] = [];
  for (const id of stationIds) {
    if (emitted.has(id)) continue;
    const family = familyForStation(id);
    const members = family ? PAINT_FAMILIES[family] : null;
    if (!family || !members || !complete.has(family)) {
      grouped.push(id);
      emitted.add(id);
      continue;
    }
    if (id !== members[0]) continue;
    for (const member of members) {
      grouped.push(member);
      emitted.add(member);
    }
  }
  return grouped;
}

/** Board order is sortOrder, then id. Ranks are the grouped sequence. */
export function groupedStationRank(stationOrder: ReadonlyMap<string, number>): Map<string, number> {
  const ids = [...stationOrder.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  return new Map(groupStationsInBoardOrder(ids).map((id, index) => [id, index]));
}

/** Family button, then that family's members, at member 1's place in board order. */
export function paletteSlots(stations: readonly { id: string; sortOrder: number }[]): PaletteSlot[] {
  const ids = stations.map((station) => station.id);
  const complete = completeFamilies(new Set(ids));
  const ordered = groupStationsInBoardOrder(
    [...stations]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((station) => station.id),
  );
  const slots: PaletteSlot[] = [];
  for (const id of ordered) {
    const family = familyForStation(id);
    if (family && complete.has(family) && id === PAINT_FAMILIES[family][0]) {
      slots.push({ kind: "family", family });
    }
    slots.push({ kind: "station", id });
  }
  return slots;
}
