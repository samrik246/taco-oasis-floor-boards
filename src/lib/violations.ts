import { assignedPaint } from "@/lib/quarter/client/intervals";
import { validateAssignment } from "@/lib/rules/assign";
import { chicagoHourOf } from "@/lib/hour-grid";
import type { AbilityLevel, RuleViolation, ViolationCode } from "@/lib/rules/types";
import type { DayBoardDto, ShiftDto, StationDto } from "@/components/board/types";

export type BoardViolation = {
  code: ViolationCode;
  message: string;
  assignmentId: string | null;
  interval?: {shiftId:string;startAt:string;endAt:string};
  employeeName: string;
  stationId: string;
  hourLabel: string;
};

function abilityLevel(
  shift: ShiftDto,
  stationId: string,
  abilityBlocked: boolean | undefined,
): AbilityLevel | null {
  if (shift.employee.abilities) {
    const a = shift.employee.abilities.find((x) => x.stationId === stationId);
    return (a?.level as AbilityLevel | undefined) ?? null;
  }
  return abilityBlocked ? "forbidden" : null;
}

function chicagoHourLabel(iso: string): string {
  const h = chicagoHourOf(new Date(iso));
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${suffix}`;
}

/**
 * Scan a day board for slipped-in rule violations (SPEC slice 12).
 * Pure: re-validates each assignment against current occupancy/abilities.
 */
export function findBoardViolations(day: DayBoardDto): BoardViolation[] {
  if(day.quarter)return findIntervalViolations(day);
  const stationById = new Map<string, StationDto>(
    day.stations.map((s) => [s.id, s]),
  );

  type Flat = {
    assignmentId: string;
    stationId: string;
    hourStartMs: number;
    hourStartIso: string;
    abilityBlocked: boolean | undefined;
    shift: ShiftDto;
  };

  const flat: Flat[] = [];
  for (const sh of day.shifts) {
    for (const a of sh.assignments) {
      flat.push({
        assignmentId: a.id,
        stationId: a.stationId,
        hourStartMs: new Date(a.hourStart).getTime(),
        hourStartIso: a.hourStart,
        abilityBlocked: a.abilityBlocked,
        shift: sh,
      });
    }
  }

  const out: BoardViolation[] = [];

  for (const row of flat) {
    const station = stationById.get(row.stationId);
    if (!station) {
      out.push({
        code: "STATION_NOT_FOUND",
        message: `Assignment references missing station ${row.stationId}`,
        assignmentId: row.assignmentId,
        employeeName: `${row.shift.employee.firstName} ${row.shift.employee.lastName}`.trim(),
        stationId: row.stationId,
        hourLabel: chicagoHourLabel(row.hourStartIso),
      });
      continue;
    }

    const sameStationHour = flat.filter(
      (f) =>
        f.stationId === row.stationId && f.hourStartMs === row.hourStartMs,
    );
    // Occupancy excluding self (updatingExistingOnStation = true)
    const existingOccupancy = sameStationHour.length;
    const personElsewhere = flat.some(
      (f) =>
        f.assignmentId !== row.assignmentId &&
        f.hourStartMs === row.hourStartMs &&
        f.shift.employee.id === row.shift.employee.id,
    );

    const violations: RuleViolation[] = validateAssignment({
      hourStart: new Date(row.hourStartIso),
      shiftStart: new Date(row.shift.startAt),
      shiftEnd: new Date(row.shift.endAt),
      stationId: station.id,
      stationBoard: day.board,
      shiftBoard: row.shift.board,
      maxConcurrent: station.maxConcurrent,
      existingOccupancy,
      updatingExistingOnStation: true,
      abilityLevel: abilityLevel(row.shift, station.id, row.abilityBlocked),
      personAlreadyAssignedAtHour: personElsewhere,
      chicagoHour: chicagoHourOf(new Date(row.hourStartIso)),
    });

    for (const v of violations) {
      out.push({
        code: v.code,
        message: v.message,
        assignmentId: row.assignmentId,
        employeeName: `${row.shift.employee.firstName} ${row.shift.employee.lastName}`.trim(),
        stationId: station.id,
        hourLabel: chicagoHourLabel(row.hourStartIso),
      });
    }
  }

  return out;
}

/** Each simultaneous occupancy is measured between actual boundaries, never by hour-row count. */
function findIntervalViolations(day:DayBoardDto):BoardViolation[] {
  const rows=day.shifts.flatMap(shift=>assignedPaint(shift).map(p=>({...p,shift,start:Date.parse(p.startAt),end:Date.parse(p.endAt)})));
  const out:BoardViolation[]=[];
  const clock=(ms:number)=>new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",hour:"numeric",minute:"2-digit"}).format(new Date(ms));
  for(const row of rows){
    const station=day.stations.find(s=>s.id===row.stationId);
    const points=[...new Set([row.start,row.end,...rows.flatMap(r=>[r.start,r.end]).filter(p=>p>row.start&&p<row.end)])].sort((a,b)=>a-b);
    for(let i=1;i<points.length;i++){
      const start=points[i-1],end=points[i],active=rows.filter(r=>r.start<end&&r.end>start);
      const violations:RuleViolation[]=station?validateAssignment({hourStart:new Date(start),hourEnd:new Date(end),shiftStart:new Date(row.shift.startAt),shiftEnd:new Date(row.shift.endAt),
        stationId:station.id,stationBoard:day.board,shiftBoard:row.shift.board,maxConcurrent:station.maxConcurrent,
        existingOccupancy:new Set(active.filter(r=>r.stationId===row.stationId).map(r=>r.shift.employee.id)).size,updatingExistingOnStation:true,
        abilityLevel:abilityLevel(row.shift,station.id,row.abilityBlocked),personAlreadyAssignedAtHour:active.some(r=>r!==row&&r.shift.employee.id===row.shift.employee.id&&r.stationId!==row.stationId),
        chicagoHour:chicagoHourOf(new Date(start))}):[{code:"STATION_NOT_FOUND",message:`Interval references missing station ${row.stationId}`}];
      for(const v of violations){
        const prior=out.find(o=>o.code===v.code&&o.stationId===row.stationId&&o.interval?.shiftId===row.shift.id&&Date.parse(o.interval.endAt)===start);
        if(prior?.interval){prior.interval.endAt=new Date(end).toISOString();prior.hourLabel=`${clock(Date.parse(prior.interval.startAt))}–${clock(end)}`;}
        else out.push({code:v.code,message:v.message,assignmentId:null,interval:{shiftId:row.shift.id,startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString()},
          employeeName:`${row.shift.employee.firstName} ${row.shift.employee.lastName}`.trim(),stationId:row.stationId,hourLabel:`${clock(start)}–${clock(end)}`});
      }
    }
  }
  return out;
}
