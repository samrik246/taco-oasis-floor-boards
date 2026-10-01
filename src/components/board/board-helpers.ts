import { assignedPaint } from "@/lib/quarter/client/intervals";
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
  const a = shift.employee.abilities?.find((x) => x.stationId === stationId);
  return (a?.level as AbilityLevel | undefined) ?? null;
}

/** Shifts in window for hour, not already assigned at that hour. */
export function availableShiftsForHour(
  shifts: ShiftDto[],
  date: string,
  hour: number,
): ShiftDto[] {
  const hourStart = chicagoHourStart(date, hour);
  if(shifts.some(sh=>sh.paintHours!==undefined))return availableShiftsForInterval(shifts,+hourStart,+hourStart+3600000);
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

/** Availability throughout the factual intersection; no first-fragment wins. */
export function availableShiftsForInterval(shifts:ShiftDto[],start:number,end:number):ShiftDto[]{
  return shifts.filter(sh=>{
    if(sh.supersededAt||Date.parse(sh.startAt)>=end||Date.parse(sh.endAt)<=start)return false;
    const left=Math.max(start,Date.parse(sh.startAt)),right=Math.min(end,Date.parse(sh.endAt));
    return !shifts.some(other=>other.employee.id===sh.employee.id&&assignedPaint(other).some(p=>Date.parse(p.startAt)<right&&Date.parse(p.endAt)>left));
  }).sort((a,b)=>displayName(a).localeCompare(displayName(b)));
}
export function paintsAtStationInterval(shifts:ShiftDto[],stationId:string,start:number,end:number){
  return shifts.flatMap(shift=>assignedPaint(shift).filter(p=>p.stationId===stationId&&Date.parse(p.startAt)<end&&Date.parse(p.endAt)>start).map(p=>({shift,paint:{...p,
    startAt:new Date(Math.max(start,Date.parse(p.startAt))).toISOString(),endAt:new Date(Math.min(end,Date.parse(p.endAt))).toISOString()}})));
}

/**
 * Every non-superseded shift for the open board/date, one row per shift id —
 * Planner A's Turno completo list. Unlike `availableShiftsForHour`, not
 * filtered by the selected hour or by whether the person is already seated
 * that hour: a split day shows both halves, and someone already seated at
 * the selected hour can still be tapped, since whole-shift placement skips
 * only the individual hours that are actually taken.
 */
export function shiftsForWholeDay(shifts: ShiftDto[]): ShiftDto[] {
  return shifts
    .filter((sh) => !sh.supersededAt)
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
    green: "bg-green-600 border-green-800 text-white",
    yellow: "bg-yellow-400 border-yellow-700 text-yellow-950",
    purple: "bg-purple-200 border-purple-800 text-purple-950",
    lime: "bg-lime-300 border-lime-800 text-lime-950",
    blue: "bg-blue-200 border-blue-800 text-blue-950",
    lavender: "bg-violet-200 border-violet-700 text-violet-950",
    gray: "bg-neutral-200 border-neutral-700 text-neutral-950",
    teal: "bg-teal-200 border-teal-800 text-teal-950",
    orange: "bg-orange-200 border-orange-800 text-orange-950",
    cyan: "bg-cyan-200 border-cyan-800 text-cyan-950",
    red: "bg-red-600 border-red-800 text-white",
    brown: "bg-[#6f4e37] border-[#3e2723] text-white",
    maroon: "bg-[#8c1a11] border-red-950 text-white",
    gold: "bg-amber-600 border-amber-800 text-white",
    "light-red": "bg-red-300 border-red-700 text-red-950",
    "light-brown": "bg-[#e4c49a] border-[#8a5a2b] text-[#3f2a14]",
    "light-orange": "bg-orange-300 border-orange-700 text-orange-950",
    "deep-orange": "bg-orange-600 border-orange-900 text-white",
    "dark-orange": "bg-orange-800 border-orange-950 text-white",
    "light-green": "bg-green-300 border-green-700 text-green-950",
    "dark-green": "bg-green-800 border-green-950 text-white",
    "light-sky": "bg-sky-200 border-sky-700 text-sky-950",
    sky: "bg-sky-600 border-sky-800 text-white",
    "dark-sky": "bg-sky-700 border-sky-900 text-white",
    "deep-sky": "bg-sky-900 border-sky-950 text-white",
    "light-pink": "bg-pink-200 border-pink-700 text-pink-950",
    "dark-pink": "bg-pink-600 border-pink-900 text-white",
    violet: "bg-violet-700 border-violet-950 text-white",
    "gray-blue": "bg-slate-300 border-slate-600 text-slate-950",
    white: "bg-white border-neutral-900 text-neutral-950",
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
