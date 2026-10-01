import { z } from "zod";
import { coverDisplaySchema } from "@/lib/board/cover-display";
import { chicagoYmd } from "@/lib/schedule/build-schedule";
import { isAuxiliaryPosition, isMainBoardPosition } from "@/lib/board/auxiliary";
import type { DayBoardDto } from "@/components/board/types";

const id=z.string().min(1), instant=z.iso.datetime(), hash=z.string().regex(/^[a-f0-9]{64}$/), revision=z.string().regex(/^(0|[1-9][0-9]*)$/);
const source=z.object({shiftId:id,employeeId:id,date:z.iso.date(),board:z.enum(["caja","cocina","other"]),sourcePosition:z.string(),
  startAt:instant,endAt:instant,supersededAt:instant.nullable(),boardRemoved:z.boolean()});
export const intervalSchema=z.object({startAt:instant,endAt:instant,state:z.enum(["assigned","erased","off"]),stationId:id.nullable(),seatNumber:z.number().int().positive().nullable(),abilityBlocked:z.boolean().optional(),
  provenance:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("legacy"),assignmentId:id.nullable(),startAt:instant.optional(),endAt:instant.optional()}),
    z.object({kind:z.literal("v2"),paintHourId:id,segmentId:id}),
  ])}).refine(i=>i.startAt<i.endAt&&(i.state==="assigned"?i.stationId!==null:i.stationId===null),"Invalid interval");
const hour=z.object({shiftId:id,hourStart:instant,revision:revision.nullable(),legacySha256:hash.optional(),intervals:z.array(intervalSchema)})
  .refine(h=>h.revision!==null||Boolean(h.legacySha256),"Missing legacy expectation");
export const publicDaySchema=z.object({schemaVersion:z.literal(2),databaseEpoch:id.nullable(),worldRevision:revision.nullable(),phase:z.enum(["legacy","prepared","active"]),
  capabilitySha256:hash,board:z.enum(["caja","cocina"]),date:z.iso.date(),
  employees:z.array(z.object({id,firstName:z.string(),lastName:z.string()})),
  stations:z.array(z.object({id,label:z.string(),color:z.string(),maxConcurrent:z.number().int().min(-1),sortOrder:z.number(),priority:z.number().nullable().optional(),shortCode:z.string().nullable()})),
  sources:z.array(source),hours:z.array(hour),coverDisplay:coverDisplaySchema,
  stationUse:z.array(z.object({stationId:id,count:z.number().nonnegative()})).optional(),
  breaks:z.array(z.object({employeeId:id,shiftId:id,startAt:instant,endAt:instant,coverEmployeeId:id.nullable().optional(),auto:z.boolean().optional()})).optional(),
  overlays:z.array(z.object({id,kind:z.enum(["switch","remove","add"]),employeeId:id,partnerEmployeeId:id.nullable(),stationId:id,fromStationId:id.nullable(),
    startAt:instant,endAt:instant,managerId:id,managerName:z.string(),cancelledAt:instant.nullable(),endReason:z.enum(["cancel","import"]).nullable()})).optional(),
}).superRefine((d,ctx)=>{
  const fail=()=>ctx.addIssue({code:"custom",message:"Inconsistent public interval snapshot"});
  const ids=new Set(d.sources.map(s=>s.shiftId)), people=new Set(d.employees.map(e=>e.id)), keys=new Set<string>();
  if(ids.size!==d.sources.length||people.size!==d.employees.length||(d.phase!=="legacy"&&(!d.databaseEpoch||d.worldRevision===null)))fail();
  if(d.sources.some(s=>s.boardRemoved||s.date!==d.date||!people.has(s.employeeId)||s.startAt>=s.endAt))fail();
  if(d.employees.some(e=>!d.sources.some(s=>s.employeeId===e.id)))fail();
  for(const h of d.hours){
    const key=`${h.shiftId}|${h.hourStart}`;
    if(!ids.has(h.shiftId)||keys.has(key))fail();keys.add(key);
    let cursor=Date.parse(h.hourStart);
    for(const i of h.intervals){if(Date.parse(i.startAt)!==cursor)fail();cursor=Date.parse(i.endAt);}
    if(cursor!==Date.parse(h.hourStart)+3600000)fail();
  }
});
export type PublicDayV2=z.infer<typeof publicDaySchema>;
export type PublicInterval=z.infer<typeof intervalSchema>;
export type PublicHour=PublicDayV2["hours"][number];

/** Explicit read model. V2 intervals never masquerade as legacy Assignment records. */
export function boardFromV2(input:unknown):DayBoardDto {
  const day=publicDaySchema.parse(input), people=new Map(day.employees.map(e=>[e.id,e]));
  return {board:day.board,date:day.date,quarter:day,
    stations:day.stations.map(s=>({...s,priority:s.priority??null,shortCode:s.shortCode??undefined})),
    shifts:day.sources.filter(s=>s.board===day.board&&isMainBoardPosition(s.sourcePosition)).map(s=>({id:s.shiftId,date:s.date,startAt:s.startAt,endAt:s.endAt,
      sourcePosition:s.sourcePosition,board:s.board,supersededAt:s.supersededAt,employee:{...people.get(s.employeeId)!,email:null},assignments:[],
      paintHours:day.hours.filter(h=>h.shiftId===s.shiftId)})),
    auxiliaryShifts:day.sources.filter(s=>!s.supersededAt&&isAuxiliaryPosition(s.sourcePosition)).map(s=>({id:s.shiftId,date:s.date,startAt:s.startAt,endAt:s.endAt,
      sourcePosition:s.sourcePosition,employee:people.get(s.employeeId)!})),
    coverDisplay:day.coverDisplay,stationUse:day.stationUse,breaks:day.breaks,overlays:day.overlays};
}
export const BOARD_CACHE_V2="taco-oasis-last-board-v2";
export const LEGACY_BOARD_CACHE="taco-oasis-last-board-v1";
const cacheSchema=z.object({version:z.literal(2),schemaVersion:z.literal(2),databaseEpoch:id,capabilitySha256:hash,
  board:z.enum(["caja","cocina"]),date:z.iso.date(),day:publicDaySchema,savedAt:instant}).refine(c=>c.board===c.day.board&&c.date===c.day.date&&
    c.databaseEpoch===c.day.databaseEpoch&&c.capabilitySha256===c.day.capabilitySha256);
export type CacheRead={status:"available";day:DayBoardDto;savedAt:string}|{status:"missing"|"unsupported"|"unavailable"};
export function saveBoardV2(input:unknown,now=new Date(),storage:Storage=window.localStorage):boolean {
  try{
    const day=publicDaySchema.parse(input);
    if(day.date!==chicagoYmd(now)||!day.databaseEpoch)return false;
    const cache=cacheSchema.parse({version:2,schemaVersion:2,databaseEpoch:day.databaseEpoch,capabilitySha256:day.capabilitySha256,
      board:day.board,date:day.date,day,savedAt:now.toISOString()});
    const bytes=JSON.stringify(cache);storage.setItem(BOARD_CACHE_V2,bytes);
    if(storage.getItem(BOARD_CACHE_V2)!==bytes)return false;
    storage.removeItem(LEGACY_BOARD_CACHE);return true;
  }catch{return false;}
}
export function readBoardV2(board:PublicDayV2["board"],now=new Date(),storage:Storage=window.localStorage):CacheRead {
  try{
    const raw=storage.getItem(BOARD_CACHE_V2);if(raw===null)return {status:"missing"};
    const result=cacheSchema.safeParse(JSON.parse(raw));if(!result.success)return {status:"unsupported"};
    if(result.data.board!==board||result.data.date!==chicagoYmd(now))return {status:"unavailable"};
    const safe=JSON.stringify(result.data);if(safe!==raw)storage.setItem(BOARD_CACHE_V2,safe);
    return {status:"available",day:boardFromV2(result.data.day),savedAt:result.data.savedAt};
  }catch{return {status:"unavailable"};}
}
