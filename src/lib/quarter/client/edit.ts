import { chicagoHourStart } from "@/lib/hour-grid";
import type { PublicDayV2 } from "./day";
import { uniformHour } from "./intervals";
import { randomId } from "./primitives";
import { activeGeneration } from "./draft-db";
import { DraftError, emptyBase, generation, newEnvelope, type DraftScope, type DraftSnapshot, type RetainedIntent } from "./draft-types";
import type { PaintIntent } from "../protocol";

export function hourEditRefusal(day:PublicDayV2,shiftId:string,hour:number):string|null {
  const source=day.sources.find(s=>s.shiftId===shiftId),start=+chicagoHourStart(day.date,hour),end=start+3600000;
  if(!source||source.supersededAt||source.boardRemoved||source.board!==day.board||Date.parse(source.startAt)>=end||Date.parse(source.endAt)<=start)return "SOURCE_NOT_AVAILABLE";
  const uniform=uniformHour({...source,assignments:[],paintHours:day.hours.filter(h=>h.shiftId===shiftId)},day.date,hour);
  if(uniform.kind==="mixed")return "HOUR_NEEDS_QUARTER";
  if(day.coverDisplay.tracks.some(t=>t.shiftId===shiftId&&t.segments.some(s=>s.kind!=="work"&&Date.parse(s.startAt)<end&&Date.parse(s.endAt)>start))||
    day.coverDisplay.unavailable.some(u=>u.employeeId===source.employeeId&&Date.parse(u.startAt)<end&&Date.parse(u.endAt)>start)||
    (day.overlays??[]).some(o=>!o.cancelledAt&&(o.employeeId===source.employeeId||o.partnerEmployeeId===source.employeeId)&&Date.parse(o.startAt)<end&&Date.parse(o.endAt)>start))return "HOUR_HAS_OBLIGATION";
  return null;
}
export function proposeHour(scope:DraftScope,snapshot:DraftSnapshot,day:PublicDayV2,shiftId:string,hour:number,action:Omit<PaintIntent,"shiftId"|"quarter"|"granularity">&{stationId?:string;family?:string},now=new Date().toISOString()){
  const refusal=hourEditRefusal(day,shiftId,hour);if(refusal)throw new DraftError(refusal);
  if(!day.databaseEpoch||day.worldRevision===null||day.phase!=="active")throw new DraftError("QUARTER_NOT_ACTIVE");
  if(snapshot.warnings.length)throw new DraftError("DRAFT_REQUIRES_REVIEW");
  const current=activeGeneration(snapshot),base=snapshot.head??emptyBase;
  if(current&&snapshot.head?.state==="outstanding"&&current.envelope.databaseEpoch!==day.databaseEpoch)throw new DraftError("DATABASE_EPOCH_CHANGED");
  const existing=snapshot.head?.state==="outstanding"?current?.envelope.intents??[]:[];
  const prefix=`${hour.toString().padStart(2,"0")}:`,old=existing.find(i=>i.intent.shiftId===shiftId&&i.intent.quarter.startsWith(prefix));
  const source=old?.source??day.sources.find(s=>s.shiftId===shiftId)!;
  const readHour=day.hours.find(h=>h.shiftId===shiftId&&h.hourStart===chicagoHourStart(day.date,hour).toISOString())!;
  const expectation=old?.hour??(readHour.revision===null?{shiftId,hourStart:readHour.hourStart,revision:null,legacySha256:readHour.legacySha256!}:{shiftId,hourStart:readHour.hourStart,revision:readHour.revision});
  const row:RetainedIntent={intentId:randomId(),editedAt:now,source,hour:expectation,baseWorldRevision:old?.baseWorldRevision??day.worldRevision,
    intent:{...action,shiftId,quarter:`${prefix}00`,granularity:"hour"} as PaintIntent};
  const intents=[...existing.filter(i=>!(i.intent.shiftId===shiftId&&i.intent.quarter.startsWith(prefix))),row];
  const outstanding=Boolean(existing.length),reviewReasons=current?.envelope.reviewReasons??[];
  const envelope=newEnvelope({databaseEpoch:day.databaseEpoch,parentGenerationId:base.generationId,parentRevision:base.localRevision,
    episodeId:outstanding?current!.envelope.episodeId:randomId(),firstDirtyAt:outstanding?current!.envelope.firstDirtyAt:now,
    firstObservedAt:outstanding?current!.envelope.firstObservedAt:now,timeProvenance:outstanding?current!.envelope.timeProvenance:"edited",
    baseWorldRevision:outstanding?current!.envelope.baseWorldRevision:day.worldRevision,intents,pendingRequestId:snapshot.head?.pendingRequestId??null,
    migratedFromV1Sha256:current?.envelope.migratedFromV1Sha256??null,reviewReasons:[...reviewReasons]});
  if(intents.some(i=>i.baseWorldRevision!==envelope.baseWorldRevision))envelope.reviewReasons.push("DRAFT_BASE_REVISIONS_DIFFER");
  return {base,proposal:generation(scope,envelope)};
}
