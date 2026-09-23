import { toZonedTime } from "date-fns-tz";
import { HOUR_GRID_END, HOUR_GRID_START, TIMEZONE } from "@/lib/constants";
import {
  chicagoHourOf,
  chicagoHourStart,
  hourGridHours,
} from "@/lib/hour-grid";
import { isHourInShift } from "@/lib/rules/shift-window";
import { stationShortCode } from "./station-codes";

export type ScheduleShiftLike = {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  employee: {
    id: string;
    externalId: string;
    firstName: string;
    lastName: string;
  };
  assignments: Array<{
    stationId: string;
    hourStart: string;
    hourEnd: string;
  }>;
};

export type ScheduleStationLike = {
  id: string;
  label: string;
  color: string;
  sortOrder: number;
  /** Edited short code from the station row. Falls back to the seeded map. */
  shortCode?: string | null;
};

export type ScheduleMode = "all-day" | "rest-of-day";

/**
 * Same people × hours. Blocks still fill left to right.
 * name: rows A–Z, position code in the block.
 * time: rows by shift start (earliest first), position code in the block.
 * position: grouped by station, person name in the block.
 */
export type ScheduleSort = "name" | "time" | "position";

export type RestOfDayRule = "today-from-now" | "other-from-first-scheduled";

export type ScheduleBlock = {
  stationId: string;
  code: string;
  /** Position short code, or the person’s short name — depends on sort. */
  text: string;
  textKind: "position" | "person";
  color: string;
  startHour: number;
  span: number;
};

/** One row per shift: a person with two shifts on a day has two rows. */
export type SchedulePersonRow = {
  shiftId: string;
  employeeId: string;
  externalId: string;
  name: string;
  /** ISO start of the shift used for this row. */
  startAt: string;
  /** Compact start, e.g. 8a or 8:30a, shown beside the name in time sort. */
  startLabel: string;
  /** True on a person's second and later shift of the day; the UI shows its start. */
  laterShiftOfPerson: boolean;
  shiftLabel: string;
  primaryStationId: string | null;
  /** Hour → stationId | null (on shift, unassigned) | undefined (off shift) */
  hourStations: Map<number, string | null | undefined>;
  blocks: ScheduleBlock[];
};

/**
 * Position sort only. `kind: "thin"` is a compact section label, never a
 * full-width colored station banner. By-name sort uses one section with
 * `label: null` so the UI draws no section row at all.
 */
export type ScheduleSection = {
  stationId: string | null;
  label: string | null;
  color: string | null;
  kind: "thin";
  rows: SchedulePersonRow[];
};

export type ScheduleGrid = {
  hours: number[];
  mode: ScheduleMode;
  sort: ScheduleSort;
  /**
   * Always false. The people grid must not render full-width station
   * banner rows (Nieves, Carnes, …).
   */
  stationBanners: false;
  restRule: RestOfDayRule | null;
  restStartHour: number;
  headcount: number[];
  manHours: number[];
  sections: ScheduleSection[];
};

function personName(sh: ScheduleShiftLike): string {
  return `${sh.employee.firstName} ${sh.employee.lastName}`.trim();
}

/** Compact clock for the left column: 8a, or 8:30a when the shift is not on the hour. */
export function formatStartLabel(startAt: string): string {
  const local = toZonedTime(new Date(startAt), TIMEZONE);
  const hour = local.getHours();
  const minute = local.getMinutes();
  const suffix = hour >= 12 ? "p" : "a";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  if (minute === 0) return `${h12}${suffix}`;
  return `${h12}:${String(minute).padStart(2, "0")}${suffix}`;
}

type RowOrderKey = { name: string; employeeId: string; startAt: string; shiftId: string };

function startMs(row: { startAt: string }): number {
  return new Date(row.startAt).getTime();
}

/** Name sort: person, then start. Time sort: start, then person. Shift id breaks ties. */
function compareScheduleRows(a: RowOrderKey, b: RowOrderKey, sort: ScheduleSort): number {
  if (sort === "time") {
    const delta = startMs(a) - startMs(b);
    if (delta !== 0) return delta;
  }
  return (
    a.name.localeCompare(b.name) ||
    a.employeeId.localeCompare(b.employeeId) ||
    startMs(a) - startMs(b) ||
    a.shiftId.localeCompare(b.shiftId)
  );
}

/** Shift window in Chicago wall time with exact minutes: 7a–3p, 9:30a–4:15p. */
export function formatShiftWindowLabel(startAt: string, endAt: string): string {
  return `${formatStartLabel(startAt)}–${formatStartLabel(endAt)}`;
}

export function chicagoYmd(date: Date): string {
  const local = toZonedTime(date, TIMEZONE);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const d = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function stationAtHour(
  sh: ScheduleShiftLike,
  date: string,
  hour: number,
): string | null | undefined {
  const hourStart = chicagoHourStart(date, hour);
  if (!isHourInShift(hourStart, new Date(sh.startAt), new Date(sh.endAt))) {
    return undefined;
  }
  const hit = sh.assignments.find(
    (a) => new Date(a.hourStart).getTime() === hourStart.getTime(),
  );
  return hit?.stationId ?? null;
}

function primaryStationId(
  sh: ScheduleShiftLike,
  date: string,
  allHours: number[],
): string | null {
  const counts = new Map<string, number>();
  for (const hour of allHours) {
    const sid = stationAtHour(sh, date, hour);
    if (typeof sid === "string") {
      counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [sid, n] of counts) {
    if (n > bestN) {
      best = sid;
      bestN = n;
    }
  }
  return best;
}

function shortPersonLabel(name: string, duplicateFirst: boolean): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? name;
  if (duplicateFirst && parts.length > 1) {
    return `${first} ${parts[1]![0]}.`;
  }
  return first;
}

export function personLabelsByName(names: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const first = name.split(/\s+/).filter(Boolean)[0] ?? name;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const name of names) {
    const first = name.split(/\s+/).filter(Boolean)[0] ?? name;
    labels.set(name, shortPersonLabel(name, (counts.get(first) ?? 0) > 1));
  }
  return labels;
}

export function buildBlocksForHours(
  hourStations: Map<number, string | null | undefined>,
  hours: number[],
  stationsById: Map<string, ScheduleStationLike>,
  label: { textKind: "position" | "person"; personText: string } = {
    textKind: "position",
    personText: "",
  },
): ScheduleBlock[] {
  const blocks: ScheduleBlock[] = [];
  let i = 0;
  while (i < hours.length) {
    const hour = hours[i]!;
    const sid = hourStations.get(hour);
    if (typeof sid !== "string") {
      i += 1;
      continue;
    }
    let span = 1;
    while (
      i + span < hours.length &&
      hourStations.get(hours[i + span]!) === sid
    ) {
      span += 1;
    }
    const st = stationsById.get(sid);
    const code = st?.shortCode?.trim() || stationShortCode(sid);
    blocks.push({
      stationId: sid,
      code,
      text: label.textKind === "person" ? label.personText : code,
      textKind: label.textKind,
      color: st?.color ?? "gray",
      startHour: hour,
      span,
    });
    i += span;
  }
  return blocks;
}

/** People grid never uses full-width station banner rows. */
export function scheduleHasFullWidthStationBanners(
  grid: ScheduleGrid,
): boolean {
  return grid.stationBanners;
}

/**
 * Rest-of-day column start:
 * - Viewing today (Chicago): from current hour (clamped to grid).
 * - Other dates: from the earliest hour that still has someone on shift
 *   (first scheduled hour). Labeled in the UI accordingly.
 */
export function resolveRestOfDayStart(opts: {
  dateYmd: string;
  now?: Date;
  hoursWithShiftCoverage: number[];
}): { startHour: number; rule: RestOfDayRule } {
  const now = opts.now ?? new Date();
  const today = chicagoYmd(now);
  if (opts.dateYmd === today) {
    const h = chicagoHourOf(now);
    return {
      startHour: Math.min(
        Math.max(h, HOUR_GRID_START),
        HOUR_GRID_END - 1,
      ),
      rule: "today-from-now",
    };
  }
  const first =
    opts.hoursWithShiftCoverage.length > 0
      ? Math.min(...opts.hoursWithShiftCoverage)
      : HOUR_GRID_START;
  return {
    startHour: Math.min(Math.max(first, HOUR_GRID_START), HOUR_GRID_END - 1),
    rule: "other-from-first-scheduled",
  };
}

export function buildScheduleGrid(opts: {
  date: string;
  shifts: ScheduleShiftLike[];
  stations: ScheduleStationLike[];
  mode: ScheduleMode;
  sort?: ScheduleSort;
  now?: Date;
  unassignedGroupLabel: string;
}): ScheduleGrid {
  const allHours = hourGridHours();
  const stationsById = new Map(opts.stations.map((s) => [s.id, s]));

  // One row per shift. A person with a split shift gets one row per shift.
  const dayShifts = opts.shifts.filter((sh) => sh.date === opts.date);
  const firstShiftByEmp = new Map<string, ScheduleShiftLike>();
  for (const sh of dayShifts) {
    const prev = firstShiftByEmp.get(sh.employee.id);
    if (
      !prev ||
      startMs(sh) < startMs(prev) ||
      (startMs(sh) === startMs(prev) && sh.id < prev.id)
    ) {
      firstShiftByEmp.set(sh.employee.id, sh);
    }
  }

  const hoursWithShiftCoverage: number[] = [];
  for (const hour of allHours) {
    const hourStart = chicagoHourStart(opts.date, hour);
    const any = dayShifts.some((sh) =>
      isHourInShift(hourStart, new Date(sh.startAt), new Date(sh.endAt)),
    );
    if (any) hoursWithShiftCoverage.push(hour);
  }

  let restRule: RestOfDayRule | null = null;
  let restStartHour = HOUR_GRID_START;
  let hours = allHours;
  if (opts.mode === "rest-of-day") {
    const resolved = resolveRestOfDayStart({
      dateYmd: opts.date,
      now: opts.now,
      hoursWithShiftCoverage,
    });
    restRule = resolved.rule;
    restStartHour = resolved.startHour;
    hours = allHours.filter((h) => h >= restStartHour);
  }

  const sort: ScheduleSort = opts.sort ?? "name";
  const drafts = dayShifts.map((sh) => {
    const hourStations = new Map<number, string | null | undefined>();
    for (const hour of allHours) {
      hourStations.set(hour, stationAtHour(sh, opts.date, hour));
    }
    return {
      shiftId: sh.id,
      laterShiftOfPerson: firstShiftByEmp.get(sh.employee.id) !== sh,
      employeeId: sh.employee.id,
      externalId: sh.employee.externalId,
      name: personName(sh),
      startAt: sh.startAt,
      startLabel: formatStartLabel(sh.startAt),
      shiftLabel: formatShiftWindowLabel(sh.startAt, sh.endAt),
      primaryStationId: primaryStationId(sh, opts.date, allHours),
      hourStations,
    };
  });
  const labels = personLabelsByName([...new Set(drafts.map((d) => d.name))]);
  const textKind = sort === "position" ? "person" : "position";

  const people: SchedulePersonRow[] = drafts
    .map((d) => ({
      ...d,
      blocks: buildBlocksForHours(d.hourStations, hours, stationsById, {
        textKind,
        personText: labels.get(d.name) ?? d.name,
      }),
    }))
    .sort((a, b) => compareScheduleRows(a, b, sort));

  const headcount = hours.map((hour) => {
    let n = 0;
    for (const row of people) {
      if (typeof row.hourStations.get(hour) === "string") n += 1;
    }
    return n;
  });
  // Each seated person contributes 1 man-hour in that column.
  const manHours = [...headcount];

  const sections = buildSections({
    sort,
    people,
    stations: opts.stations,
    stationsById,
    unassignedGroupLabel: opts.unassignedGroupLabel,
  });

  return {
    hours,
    mode: opts.mode,
    sort,
    stationBanners: false,
    restRule,
    restStartHour,
    headcount,
    manHours,
    sections,
  };
}

function buildSections(opts: {
  sort: ScheduleSort;
  people: SchedulePersonRow[];
  stations: ScheduleStationLike[];
  stationsById: Map<string, ScheduleStationLike>;
  unassignedGroupLabel: string;
}): ScheduleSection[] {
  if (opts.sort === "name" || opts.sort === "time") {
    return [
      {
        stationId: null,
        label: null,
        color: null,
        kind: "thin",
        rows: opts.people,
      },
    ];
  }

  const groupMap = new Map<string | null, SchedulePersonRow[]>();
  for (const row of opts.people) {
    const key = row.primaryStationId;
    const list = groupMap.get(key) ?? [];
    list.push(row);
    groupMap.set(key, list);
  }

  const sections: ScheduleSection[] = [];
  for (const st of [...opts.stations].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const rows = groupMap.get(st.id);
    if (!rows?.length) continue;
    sections.push({
      stationId: st.id,
      label: st.label,
      color: st.color,
      kind: "thin",
      rows: rows.sort((a, b) => compareScheduleRows(a, b, "name")),
    });
    groupMap.delete(st.id);
  }
  for (const [sid, rows] of groupMap) {
    if (sid == null) continue;
    sections.push({
      stationId: sid,
      label: opts.stationsById.get(sid)?.label ?? sid,
      color: opts.stationsById.get(sid)?.color ?? "gray",
      kind: "thin",
      rows,
    });
  }
  const unassigned = groupMap.get(null) ?? [];
  if (unassigned.length) {
    sections.push({
      stationId: null,
      label: opts.unassignedGroupLabel,
      color: null,
      kind: "thin",
      rows: unassigned.sort((a, b) => compareScheduleRows(a, b, "name")),
    });
  }
  return sections;
}
