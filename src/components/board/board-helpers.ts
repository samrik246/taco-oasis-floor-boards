import { isHourInShift } from "@/lib/rules/shift-window";
import { abilitySortRank } from "@/lib/rules/abilities";
import type { AbilityLevel } from "@/lib/rules/types";
import { chicagoHourStart } from "@/lib/hour-grid";
import type { AbilityDto, AssignmentDto, ShiftDto, StationDto } from "./types";

export function displayName(shift: ShiftDto): string {
  return `${shift.employee.firstName} ${shift.employee.lastName}`.trim();
}

export function abilityFor(
  shift: ShiftDto,
  stationId: string,
): AbilityLevel | null {
  const a = shift.employee.abilities.find((x) => x.stationId === stationId);
  return (a?.level as AbilityLevel | undefined) ?? null;
}

/** Shifts in window for hour, not already assigned at that hour. */
export function availableShiftsForHour(
  shifts: ShiftDto[],
  date: string,
  hour: number,
): ShiftDto[] {
  const hourStart = chicagoHourStart(date, hour);
  // A person already seated this hour on any of their shifts (for example on a
  // superseded shift's history hour) is not available on another one.
  const seated = new Set(
    shifts
      .filter((sh) =>
        sh.assignments.some((a) => new Date(a.hourStart).getTime() === hourStart.getTime()),
      )
      .map((sh) => sh.employee.id),
  );
  return shifts
    .filter((sh) => {
      if (seated.has(sh.employee.id)) return false;
      if (sh.supersededAt) return false;
      const start = new Date(sh.startAt);
      const end = new Date(sh.endAt);
      if (!isHourInShift(hourStart, start, end)) return false;
      return !sh.assignments.some(
        (a) => new Date(a.hourStart).getTime() === hourStart.getTime(),
      );
    })
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

/** Assignments at a given station + hour. */
export function assignmentsAtStationHour(
  shifts: ShiftDto[],
  stationId: string,
  date: string,
  hour: number,
): { shift: ShiftDto; assignment: AssignmentDto }[] {
  const hourStart = chicagoHourStart(date, hour).getTime();
  const out: { shift: ShiftDto; assignment: AssignmentDto }[] = [];
  for (const sh of shifts) {
    for (const a of sh.assignments) {
      if (
        a.stationId === stationId &&
        new Date(a.hourStart).getTime() === hourStart
      ) {
        out.push({ shift: sh, assignment: a });
      }
    }
  }
  return out;
}

export function sortShiftsByAbilityForStation(
  shifts: ShiftDto[],
  stationId: string,
): ShiftDto[] {
  return [...shifts].sort((a, b) => {
    const ra = abilitySortRank(abilityFor(a, stationId));
    const rb = abilitySortRank(abilityFor(b, stationId));
    if (ra !== rb) return ra - rb;
    return displayName(a).localeCompare(displayName(b));
  });
}

export function filterByAbilityLevel(
  shifts: ShiftDto[],
  stationId: string | null,
  filter: AbilityLevel | "all",
): ShiftDto[] {
  if (filter === "all" || !stationId) return shifts;
  return shifts.filter((sh) => {
    const level = abilityFor(sh, stationId) ?? "ok";
    return level === filter;
  });
}

export function stationColorClass(color: string): string {
  const map: Record<string, string> = {
    pink: "bg-pink-200 border-pink-700 text-pink-950",
    green: "bg-green-300 border-green-800 text-green-950",
    yellow: "bg-yellow-200 border-yellow-700 text-yellow-950",
    purple: "bg-purple-200 border-purple-800 text-purple-950",
    lime: "bg-lime-300 border-lime-800 text-lime-950",
    blue: "bg-blue-200 border-blue-800 text-blue-950",
    lavender: "bg-violet-200 border-violet-700 text-violet-950",
    gray: "bg-neutral-200 border-neutral-700 text-neutral-950",
    teal: "bg-teal-200 border-teal-800 text-teal-950",
    orange: "bg-orange-200 border-orange-800 text-orange-950",
    cyan: "bg-cyan-200 border-cyan-800 text-cyan-950",
    red: "bg-red-200 border-red-800 text-red-950",
    brown: "bg-amber-300 border-amber-900 text-amber-950",
  };
  return map[color] ?? "bg-neutral-100 border-neutral-600 text-neutral-900";
}

export function abilityBadgeClass(level: AbilityLevel | null): string {
  switch (level) {
    case "preferred":
      return "bg-emerald-700 text-white";
    case "ok":
      return "bg-neutral-700 text-white";
    case "training":
      return "bg-amber-600 text-white";
    case "forbidden":
      return "bg-red-700 text-white";
    default:
      return "bg-neutral-500 text-white";
  }
}

export type { AbilityDto, StationDto };
