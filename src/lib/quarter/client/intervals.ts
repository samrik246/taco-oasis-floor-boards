import { chicagoHourStart } from "@/lib/hour-grid";
import type { PublicHour } from "./day";

export type IntervalShift = {startAt:string;endAt:string;supersededAt?:string|null;paintHours?:PublicHour[];
  assignments:readonly {id?:string;stationId:string;hourStart:string;hourEnd?:string;seatNumber?:number|null;abilityBlocked?:boolean}[]};
export type BasePaint = {startAt:string;endAt:string;state:"assigned"|"erased"|"off";stationId:string|null;seatNumber:number|null;
  provenance:{kind:"legacy";assignmentId:string|null}|{kind:"v2";paintHourId:string;segmentId:string};abilityBlocked?:boolean};
/** Read-only normalized intervals; callers must not treat provenance as a mutation selector. */
export function basePaint(shift:IntervalShift):BasePaint[] {
  if(shift.paintHours!==undefined)return shift.paintHours.flatMap(h=>h.intervals);
  return shift.assignments.flatMap(a=>{
    const start=Math.max(Date.parse(shift.startAt),Date.parse(a.hourStart));
    const end=Math.min(Date.parse(shift.endAt),a.hourEnd?Date.parse(a.hourEnd):Date.parse(a.hourStart)+3600000);
    return start<end?[{startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),state:"assigned" as const,
      stationId:a.stationId,seatNumber:a.seatNumber??null,provenance:{kind:"legacy" as const,assignmentId:a.id??null},abilityBlocked:a.abilityBlocked}]:[];
  });
}
export function assignedPaint(shift:IntervalShift):Array<BasePaint&{stationId:string}> {
  return basePaint(shift).filter((i):i is BasePaint&{stationId:string}=>i.state==="assigned"&&i.stationId!==null);
}
export function intersectingPaint(shift:IntervalShift,start:number,end:number){
  return basePaint(shift).flatMap(i=>{
    const left=Math.max(start,Date.parse(i.startAt)),right=Math.min(end,Date.parse(i.endAt));
    return left<right?[{...i,startAt:new Date(left).toISOString(),endAt:new Date(right).toISOString()}]:[];
  });
}
export function uniformHour(shift:IntervalShift,date:string,hour:number):{kind:"off"|"empty"|"uniform"|"mixed";stationId:string|null;seatNumber:number|null} {
  const start=+chicagoHourStart(date,hour),end=start+3600000;
  const parts=intersectingPaint(shift,start,end).filter(p=>p.state!=="off");
  if(!parts.length)return {kind:shift.supersededAt||Date.parse(shift.startAt)>=end||Date.parse(shift.endAt)<=start?"off":"empty",stationId:null,seatNumber:null};
  const shapes=new Set(parts.map(p=>`${p.state}:${p.stationId}:${p.seatNumber}`));
  if(shapes.size!==1)return {kind:"mixed",stationId:null,seatNumber:null};
  const first=parts[0];
  return {kind:first.state==="assigned"?"uniform":"empty",stationId:first.stationId,seatNumber:first.seatNumber};
}
export function occupiedMilliseconds(intervals:readonly {startAt:string;endAt:string}[]):number {
  let total=0,start=0,end=0;
  for(const i of [...intervals].sort((a,b)=>Date.parse(a.startAt)-Date.parse(b.startAt))){
    const a=Date.parse(i.startAt),b=Date.parse(i.endAt);
    if(a>end){total+=end-start;start=a;end=b;}else end=Math.max(end,b);
  }
  return total+end-start;
}
