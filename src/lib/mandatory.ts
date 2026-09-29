import { markForStation } from "@/lib/selection-mark";
import { chicagoHourOf, chicagoHourStart } from "@/lib/hour-grid";
import { buildDaySlices, hourSliceIndexes, type DaySlices, type SlicePaint } from "@/lib/slices/day-slices";

/**
 * Stations that are mandatory every day. They cannot be unmarked.
 * List order is the board-day `stationIds` order. Palette order is separate.
 */
export const MANDATORY_STATIONS_BY_BOARD = {
  cocina: ["pdf_tq1r", "pdf_tf1r", "pdf_pr1e", "pdf_br1a", "pdf_guia"],
  caja: ["green1", "purple1", "yellow", "nieves", "mana"],
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
 * Empty star slices from 11:00 on. One hour is a gap when any of its quarters is.
 * A pending draft replaces the saved station for that hour.
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
  const day = gapSlices(input);
  const gapHours = input.hours.filter((hour) => hour >= MANDATORY_GAP_START);
  const stationIds = input.boardOrder
    ? stationsInBoardOrder(input.stationIds, input.boardOrder)
    : input.stationIds;
  const gaps: MandatoryGap[] = [];
  for (const stationId of stationIds) {
    for (const hour of gapHours) {
      const open = hourSliceIndexes(hour).some((index) => {
        return day.slices[index]?.emptyStarStationIds.includes(stationId);
      });
      if (open) gaps.push({ stationId, hour });
    }
  }
  return gaps;
}

/** Quarter gaps from 11:00, one per empty star slice. Shown at any painted percent. */
export function huecosCount(day: DaySlices): number {
  let count = 0;
  for (const slice of day.slices) {
    if (chicagoHourOf(slice.start) < MANDATORY_GAP_START) continue;
    count += slice.emptyStarStationIds.length;
  }
  return count;
}

function gapSlices(input: {
  stationIds: readonly string[];
  date: string;
  shifts: readonly MandatoryGapShift[];
  drafts?: readonly MandatoryGapDraft[];
}): DaySlices {
  const drafts = new Map<string, string | null>(
    (input.drafts ?? []).map((draft) => [`${draft.shiftId}|${draft.hour}`, draft.stationId]),
  );
  const paints: SlicePaint[] = [];
  const shifts = input.shifts.filter((shift) => shift.date === input.date);
  for (const shift of shifts) {
    const hours = new Map<number, string>();
    if (!shift.supersededAt) {
      for (const assignment of shift.assignments) {
        hours.set(chicagoHourOf(new Date(assignment.hourStart)), assignment.stationId);
      }
    }
    for (const [key, stationId] of drafts) {
      const [shiftId, hourText] = key.split("|");
      if (shiftId !== shift.id) continue;
      const hour = Number(hourText);
      if (stationId == null) hours.delete(hour);
      else hours.set(hour, stationId);
    }
    for (const [hour, stationId] of hours) {
      paints.push({
        employeeId: shift.id,
        shiftId: shift.id,
        stationId,
        hourStart: chicagoHourStart(input.date, hour),
      });
    }
  }
  return buildDaySlices({
    date: input.date,
    board: "cocina",
    now: chicagoHourStart(input.date, MANDATORY_GAP_START),
    stations: input.stationIds.map((id) => ({ id })),
    starStationIds: input.stationIds,
    shifts: shifts.map((shift) => ({
      id: shift.id,
      employeeId: shift.id,
      board: "cocina",
      startAt: new Date(shift.startAt),
      endAt: new Date(shift.endAt),
      superseded: Boolean(shift.supersededAt),
      boardRemoved: false,
    })),
    paints,
    breaks: [],
    overlays: [],
  });
}

export type EligibilityDot = { stationId: string; level: "training" | "ok" | "preferred" };

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
 * One dot per default-mandatory gap this person may work, in gap order.
 * One-day marks stay in `gaps` for Falta and the footer; they are not dots.
 * No abilities array means levels are absent: no dots.
 * A missing row is bien, unless that column's default is forbidden.
 * Forbidden is no dot. Training, ok, and preferred keep their own marks.
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
    if (gap.hour !== input.hour || !isDefaultMandatory(gap.stationId)) continue;
    const mark = markForStation({
      abilities,
      stationId: gap.stationId,
      columnDefault: input.columnDefaults?.get(gap.stationId),
    });
    if (mark === "none") continue;
    const row = abilities.find((ability) => ability.stationId === gap.stationId);
    const level = row?.level === "training" || row?.level === "preferred" ? row.level : "ok";
    dots.push({ stationId: gap.stationId, level });
  }
  return dots;
}
