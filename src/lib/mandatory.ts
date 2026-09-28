import { levelWhenUnset } from "@/lib/abilities/column-default";
import { chicagoHourEnd, chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";

/**
 * Stations that are mandatory every day. They cannot be unmarked.
 * List order is the board-day `stationIds` order. Palette order is separate.
 */
export const MANDATORY_STATIONS_BY_BOARD = {
  cocina: ["pdf_tq1r", "pdf_tf1r", "pdf_pr1e"],
  caja: ["green1", "purple1", "yellow", "nieves"],
} as const;

/** Cocina standing stations, in the historical board-day order. */
export const MANDATORY_STATIONS = MANDATORY_STATIONS_BY_BOARD.cocina;

const DEFAULT_MANDATORY_IDS = new Set<string>([
  ...MANDATORY_STATIONS_BY_BOARD.cocina,
  ...MANDATORY_STATIONS_BY_BOARD.caja,
]);

/** A gap counts from 11:00 through the last grid hour. Earlier hours are never gaps. */
export const MANDATORY_GAP_START = 11;

export function isDefaultMandatory(stationId: string): boolean {
  return DEFAULT_MANDATORY_IDS.has(stationId);
}

export function mandatoryGapLabel(station: { shortCode?: string | null; label: string }): string {
  const code = station.shortCode?.trim();
  return code ? code : station.label;
}

export type MandatoryGapShift = {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  supersededAt?: string | null;
  assignments: { stationId: string; hourStart: string }[];
};

export type MandatoryGapDraft = {
  shiftId: string;
  hour: number;
  stationId: string | null;
};

export type MandatoryGap = { stationId: string; hour: number };

function savedStation(shift: MandatoryGapShift, date: string, hour: number): string | null {
  const hit = shift.assignments.find((assignment) => {
    return shift.date === date && chicagoHourOf(new Date(assignment.hourStart)) === hour;
  });
  return hit?.stationId ?? null;
}

/** Same on/off rule the paint matrix uses for a cell. */
function hourIsOnMatrix(shift: MandatoryGapShift, date: string, hour: number): boolean {
  if (shift.date !== date) return false;
  if (shift.supersededAt) return savedStation(shift, date, hour) != null;
  return isHourInShift(
    chicagoHourStart(date, hour),
    new Date(shift.startAt),
    new Date(shift.endAt),
    chicagoHourEnd(date, hour),
  );
}

/**
 * Rank mandatory stations by `day.stations` (palette order).
 * A station missing from that list keeps its place after the known ones.
 */
function stationsInBoardOrder(stationIds: readonly string[], boardOrder: readonly string[]): string[] {
  const rank = new Map(boardOrder.map((id, index) => [id, index]));
  return [...stationIds].sort((a, b) => {
    const ar = rank.get(a) ?? boardOrder.length;
    const br = rank.get(b) ?? boardOrder.length;
    return ar - br;
  });
}

/**
 * Uncovered mandatory stations. Hours before 11 are never gaps.
 * A pending draft replaces the saved station on a cell the matrix shows.
 * A person at Taquero 2 does not cover Taquero 1.
 * When `boardOrder` is set, gaps follow that order for every caller.
 */
export function uncoveredMandatory(input: {
  stationIds: readonly string[];
  /** `day.stations` ids, top to bottom. Omit to keep `stationIds` order. */
  boardOrder?: readonly string[];
  hours: readonly number[];
  date: string;
  shifts: readonly MandatoryGapShift[];
  drafts?: readonly MandatoryGapDraft[];
}): MandatoryGap[] {
  const gapHours = input.hours.filter((hour) => hour >= MANDATORY_GAP_START);
  const drafts = new Map<string, string | null>(
    (input.drafts ?? []).map((draft) => [`${draft.shiftId}|${draft.hour}`, draft.stationId]),
  );
  const occupied = new Set<string>();
  for (const shift of input.shifts) {
    for (const hour of gapHours) {
      if (!hourIsOnMatrix(shift, input.date, hour)) continue;
      const draftKey = `${shift.id}|${hour}`;
      const stationId = drafts.has(draftKey) ? drafts.get(draftKey) ?? null : savedStation(shift, input.date, hour);
      if (stationId) occupied.add(`${stationId}|${hour}`);
    }
  }
  const stationIds = input.boardOrder
    ? stationsInBoardOrder(input.stationIds, input.boardOrder)
    : input.stationIds;
  const gaps: MandatoryGap[] = [];
  for (const stationId of stationIds) {
    for (const hour of gapHours) {
      if (!occupied.has(`${stationId}|${hour}`)) gaps.push({ stationId, hour });
    }
  }
  return gaps;
}

export type EligibilityDot = { stationId: string; dim: boolean };

export type EligibilityCellKind = "off" | "open" | "seated";

type EligibilityShift = {
  employee: {
    abilities?: readonly { stationId: string; level: string }[] | null;
  };
};

/**
 * A pending paint keeps the saved cell kind. A station or family fill is seated.
 * An erase pending is open. Off stays off.
 */
export function eligibilityCellKind(
  saved: EligibilityCellKind,
  pending: { stationId: string | null; family?: string } | undefined,
): EligibilityCellKind {
  if (saved === "off") return "off";
  if (!pending) return saved;
  if (pending.stationId != null || pending.family) return "seated";
  return "open";
}

/**
 * One dot per missing station this person may work, in gap order.
 * No abilities array means levels are absent: no dots, including for a missing row.
 * A missing row inside a present array is a full dot, unless that column's
 * default is forbidden. Forbidden is no dot.
 * Training is dim. Ok and preferred are full.
 */
export function eligibilityDots(input: {
  gaps: readonly MandatoryGap[];
  shift: EligibilityShift;
  hour: number;
  kind: EligibilityCellKind;
  columnDefaults?: ReadonlyMap<string, string>;
}): EligibilityDot[] {
  if (input.kind !== "open") return [];
  const abilities = input.shift.employee.abilities;
  if (!Array.isArray(abilities)) return [];
  const dots: EligibilityDot[] = [];
  for (const gap of input.gaps) {
    if (gap.hour !== input.hour) continue;
    const row = abilities.find((ability) => ability.stationId === gap.stationId);
    if (!row) {
      if (levelWhenUnset(undefined, input.columnDefaults?.get(gap.stationId)) === "forbidden") continue;
      dots.push({ stationId: gap.stationId, dim: false });
      continue;
    }
    if (row.level === "training") {
      dots.push({ stationId: gap.stationId, dim: true });
      continue;
    }
    if (row.level === "ok" || row.level === "preferred") {
      dots.push({ stationId: gap.stationId, dim: false });
    }
  }
  return dots;
}
