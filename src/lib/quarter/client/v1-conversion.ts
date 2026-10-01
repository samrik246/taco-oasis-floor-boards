import { z } from "zod";
import { chicagoHourStart } from "@/lib/hour-grid";
import { isPaintFamily } from "@/lib/assignments/paint-families";
import type { PublicDayV2 } from "./day";
import { canonicalJson, randomId, sha256 } from "./primitives";
import { DraftDatabase } from "./draft-db";
import { emptyBase, generation, newEnvelope, type DraftScope, type RetainedIntent, type V1Archive } from "./draft-types";

const expectedShift=z.object({startAt:z.iso.datetime(),endAt:z.iso.datetime(),employeeId:z.string(),sourcePosition:z.string()});
const legacySchema=z.object({version:z.literal(1),updatedAt:z.string(),edits:z.array(z.object({shiftId:z.string(),hour:z.number().int().min(7).max(21),
  expectedShift,expected:z.object({id:z.string(),stationId:z.string()}).nullable(),stationId:z.string().nullable(),family:z.string().refine(isPaintFamily).optional()})).max(500)});
export const v1Key=(scope:DraftScope)=>`taco-oasis-paint-draft-v1:${encodeURIComponent(scope.managerId)}:${scope.board}:${scope.date}`;

/** Compare original expectations. An equal legacy snapshot cannot prove pre-V2 ABA history. */
export function convertV1(scope:DraftScope,raw:string,day:PublicDayV2,observedAt=new Date().toISOString()) {
  const hash=sha256(raw);
  let original:unknown;try{original=JSON.parse(raw);}catch{original=null;}
  const parsed=legacySchema.safeParse(original);
  const reasons:string[]=[], intents:RetainedIntent[]=[];
  if(!parsed.success)reasons.push("V1_FORMAT_REQUIRES_REVIEW");
  if(day.board!==scope.board||day.date!==scope.date||!day.databaseEpoch||day.worldRevision===null)reasons.push("V1_SCOPE_REQUIRES_REVIEW");
  for(const edit of parsed.success?parsed.data.edits:[]){
    const source=day.sources.find(s=>s.shiftId===edit.shiftId), start=+chicagoHourStart(scope.date,edit.hour), end=start+3600000;
    const hour=day.hours.find(h=>h.shiftId===edit.shiftId&&Date.parse(h.hourStart)===start);
    if(!source||source.boardRemoved||source.supersededAt||source.board!==scope.board||source.startAt!==edit.expectedShift.startAt||source.endAt!==edit.expectedShift.endAt||
      source.employeeId!==edit.expectedShift.employeeId||source.sourcePosition!==edit.expectedShift.sourcePosition){reasons.push(`V1_SOURCE_CHANGED:${edit.shiftId}`);continue;}
    if(!hour||hour.revision!==null||!hour.legacySha256){reasons.push(`V1_HOUR_ADOPTED:${edit.shiftId}:${edit.hour}`);continue;}
    const assigned=hour.intervals.filter(i=>i.state==="assigned");
    if(edit.expected===null?assigned.length>0:assigned.length===0||assigned.some(i=>i.provenance.kind!=="legacy"||i.provenance.assignmentId!==edit.expected!.id||i.stationId!==edit.expected!.stationId||Date.parse(i.provenance.startAt??"")!==start||Date.parse(i.provenance.endAt??"")!==end)){
      reasons.push(`V1_ASSIGNMENT_CHANGED:${edit.shiftId}:${edit.hour}`);continue;
    }
    const states=new Set(hour.intervals.filter(i=>i.state!=="off").map(i=>`${i.state}:${i.stationId}`));
    const obligated=day.coverDisplay.tracks.some(t=>t.shiftId===edit.shiftId&&t.segments.some(s=>s.kind!=="work"&&Date.parse(s.startAt)<end&&Date.parse(s.endAt)>start))||
      day.coverDisplay.unavailable.some(u=>u.employeeId===source.employeeId&&Date.parse(u.startAt)<end&&Date.parse(u.endAt)>start)||
      (day.overlays??[]).some(o=>!o.cancelledAt&&(o.employeeId===source.employeeId||o.partnerEmployeeId===source.employeeId)&&Date.parse(o.startAt)<end&&Date.parse(o.endAt)>start);
    if(states.size>1||obligated){reasons.push(`V1_QUARTER_REVIEW_REQUIRED:${edit.shiftId}:${edit.hour}`);continue;}
    for(const minute of [0,15,30,45]){
      const left=start+minute*60000,right=left+900000;
      if(right<=Date.parse(source.startAt)||left>=Date.parse(source.endAt))continue;
      intents.push({intentId:randomId(),editedAt:observedAt,source,hour:{shiftId:hour.shiftId,hourStart:hour.hourStart,revision:null,legacySha256:hour.legacySha256},baseWorldRevision:day.worldRevision??"0",
        intent:{shiftId:source.shiftId,quarter:`${edit.hour.toString().padStart(2,"0")}:${minute.toString().padStart(2,"0")}`,granularity:"quarter",
          ...(edit.family&&isPaintFamily(edit.family)?{action:"family",family:edit.family}:edit.stationId?{action:"station",stationId:edit.stationId}:{action:"erase"})}});
    }
  }
  if(intents.length>2000||new TextEncoder().encode(canonicalJson(intents)).length>2*1024*1024)reasons.push("V1_SIZE_REQUIRES_REVIEW");
  // Retain the complete original; a partially matching conversion is never sendable.
  const envelope=newEnvelope({databaseEpoch:day.databaseEpoch??"unavailable",parentGenerationId:null,parentRevision:"0",episodeId:randomId(),firstDirtyAt:null,
    firstObservedAt:observedAt,timeProvenance:"recovered-v1",baseWorldRevision:day.worldRevision??"0",intents,pendingRequestId:null,migratedFromV1Sha256:hash,reviewReasons:reasons});
  const archive:V1Archive={...scope,v1Sha256:hash,original:raw,observedAt,generationId:envelope.generationId,result:reasons.length?"review":"converted",staleReason:reasons.join("; ")||null};
  return {proposal:generation(scope,envelope),archive};
}

/** Never remove or rewrite localStorage. Re-observe old-tab writes after the IDB commit. */
export async function observeV1(db:DraftDatabase,scope:DraftScope,day:PublicDayV2,storage?:Storage) {
  const snapshot=await db.read(scope);
  if(db.readOnly||snapshot.warnings.length)return {changed:false,snapshot};
  storage??=window.localStorage;
  const raw=storage.getItem(v1Key(scope));if(raw===null)return {changed:false,snapshot};
  const conversion=convertV1(scope,raw,day);
  const result=await db.retain(scope,emptyBase,conversion.proposal,conversion.archive);
  const latest=storage.getItem(v1Key(scope));
  if(latest!==raw&&latest!==null){
    // One additional observation is bounded; continuous old-tab writes stay visibly unreconciled.
    const next=convertV1(scope,latest,day);await db.retain(scope,emptyBase,next.proposal,next.archive);
    return {changed:true,snapshot:await db.read(scope)};
  }
  return {changed:latest!==raw,snapshot:result.snapshot};
}
