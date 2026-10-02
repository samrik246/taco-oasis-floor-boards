import { chicagoHourStart } from "@/lib/hour-grid";
import type { PublicDayV2 } from "./day";
import { uniformHour } from "./intervals";
import { randomId } from "./primitives";
import { activeGeneration } from "./draft-db";
import { commandFor, DraftError, emptyBase, generation, newEnvelope, type DraftScope, type DraftSnapshot, type RetainedIntent } from "./draft-types";
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
export type HourChange={shiftId:string;hour:number;action:Omit<PaintIntent,"shiftId"|"quarter"|"granularity">&{stationId?:string;family?:string}};
export type QuarterChange = HourChange & { minute: 0 | 15 | 30 | 45 };

/** Selected quarters still obey recorded source identity and saved obligations. */
export function quarterEditRefusal(day: PublicDayV2, shiftId: string, hour: number, minute: number): string | null {
  if (!Number.isInteger(hour) || hour < 7 || hour > 21 || ![0, 15, 30, 45].includes(minute)) return "INVALID_QUARTER";
  const source = day.sources.find(s => s.shiftId === shiftId);
  const start = +chicagoHourStart(day.date, hour) + minute * 60_000, end = start + 900_000;
  if (!source || source.supersededAt || source.boardRemoved || source.board !== day.board || Date.parse(source.startAt) >= end || Date.parse(source.endAt) <= start) return "SOURCE_NOT_AVAILABLE";
  if (day.coverDisplay.tracks.some(t => t.shiftId === shiftId && t.segments.some(s => s.kind !== "work" && Date.parse(s.startAt) < end && Date.parse(s.endAt) > start)) ||
    day.coverDisplay.unavailable.some(u => u.employeeId === source.employeeId && Date.parse(u.startAt) < end && Date.parse(u.endAt) > start) ||
    (day.overlays ?? []).some(o => !o.cancelledAt && (o.employeeId === source.employeeId || o.partnerEmployeeId === source.employeeId) && Date.parse(o.startAt) < end && Date.parse(o.endAt) > start)) return "QUARTER_HAS_OBLIGATION";
  return null;
}

/** Extend the same CAS envelope. Sibling quarters keep their original expectations and intent IDs. */
export function proposeQuarters(scope: DraftScope, snapshot: DraftSnapshot, day: PublicDayV2, changes: QuarterChange[], now = new Date().toISOString()) {
  if (!day.databaseEpoch || day.worldRevision === null || day.phase !== "active") throw new DraftError("QUARTER_NOT_ACTIVE");
  if (!changes.length || changes.length > 2000) throw new DraftError("TOO_MANY_INTENTS");
  if (snapshot.warnings.length) throw new DraftError("DRAFT_REQUIRES_REVIEW");
  const current = activeGeneration(snapshot), base = snapshot.head ?? emptyBase;
  const outstanding = snapshot.head?.state === "outstanding";
  if (outstanding && current?.envelope.databaseEpoch !== day.databaseEpoch) throw new DraftError("DATABASE_EPOCH_CHANGED");
  const existing = outstanding ? current?.envelope.intents ?? [] : [];
  let intents = [...existing];
  for (const { shiftId, hour, minute, action } of changes) {
    const refusal = quarterEditRefusal(day, shiftId, hour, minute);
    if (refusal) throw new DraftError(refusal);
    const prefix = `${String(hour).padStart(2, "0")}:`, quarter = `${prefix}${String(minute).padStart(2, "0")}`;
    const old = intents.find(i => i.intent.shiftId === shiftId && i.intent.quarter.startsWith(prefix));
    const source = old?.source ?? intents.find(i => i.intent.shiftId === shiftId)?.source ?? day.sources.find(s => s.shiftId === shiftId)!;
    const read = day.hours.find(h => h.shiftId === shiftId && h.hourStart === chicagoHourStart(day.date, hour).toISOString());
    if (!read) throw new DraftError("SOURCE_CHANGED");
    const expectation = old?.hour ?? (read.revision === null ? { shiftId, hourStart: read.hourStart, revision: null, legacySha256: read.legacySha256! } : { shiftId, hourStart: read.hourStart, revision: read.revision });
    // A private whole-hour proposal becomes exact quarters before one is replaced.
    // The submitted immutable generation, if any, remains intact in the database.
    const whole = intents.find(i => i.intent.shiftId === shiftId && i.intent.quarter.startsWith(prefix) && i.intent.granularity === "hour");
    if (whole) {
      intents = intents.filter(i => i !== whole);
      for (const m of [0, 15, 30, 45]) {
        const start = +chicagoHourStart(day.date, hour) + m * 60_000;
        if (Date.parse(whole.source.startAt) < start + 900_000 && Date.parse(whole.source.endAt) > start) {
          intents.push({ ...whole, intentId: randomId(), intent: { ...whole.intent, quarter: `${prefix}${String(m).padStart(2, "0")}`, granularity: "quarter" } });
        }
      }
    }
    const row: RetainedIntent = { intentId: randomId(), editedAt: now, source, hour: expectation, baseWorldRevision: old?.baseWorldRevision ?? day.worldRevision,
      intent: { ...action, shiftId, quarter, granularity: "quarter" } as PaintIntent };
    intents = [...intents.filter(i => !(i.intent.shiftId === shiftId && i.intent.quarter === quarter)), row];
  }
  const dirty = Boolean(existing.length);
  const envelope = newEnvelope({ databaseEpoch: day.databaseEpoch, parentGenerationId: base.generationId, parentRevision: base.localRevision,
    episodeId: dirty ? current!.envelope.episodeId : randomId(), firstDirtyAt: dirty ? current!.envelope.firstDirtyAt : now,
    firstObservedAt: dirty ? current!.envelope.firstObservedAt : now, timeProvenance: dirty ? current!.envelope.timeProvenance : "edited",
    baseWorldRevision: dirty ? current!.envelope.baseWorldRevision : day.worldRevision, intents, pendingRequestId: snapshot.head?.pendingRequestId ?? null,
    migratedFromV1Sha256: dirty ? current!.envelope.migratedFromV1Sha256 : null, reviewReasons: [...(dirty ? current!.envelope.reviewReasons : [])] });
  if (intents.some(i => i.baseWorldRevision !== envelope.baseWorldRevision) && !envelope.reviewReasons.includes("DRAFT_BASE_REVISIONS_DIFFER")) envelope.reviewReasons.push("DRAFT_BASE_REVISIONS_DIFFER");
  const proposal = generation(scope, envelope);
  // Check protocol/serialized limits before storage, without discarding review-only work.
  if (intents.length > 2000 || new Set(intents.map(i => `${i.hour.shiftId}|${i.hour.hourStart}`)).size > 500) throw new DraftError("TOO_MANY_INTENTS");
  if (!envelope.reviewReasons.length) commandFor(proposal, day.capabilitySha256);
  return { base, proposal };
}
export function proposeHour(scope:DraftScope,snapshot:DraftSnapshot,day:PublicDayV2,shiftId:string,hour:number,action:HourChange["action"],now=new Date().toISOString()){
  return proposeHours(scope,snapshot,day,[{shiftId,hour,action}],now);
}
export function proposeHours(scope:DraftScope,snapshot:DraftSnapshot,day:PublicDayV2,changes:HourChange[],now=new Date().toISOString()){
  if(!day.databaseEpoch||day.worldRevision===null||day.phase!=="active")throw new DraftError("QUARTER_NOT_ACTIVE");
  if(!changes.length||changes.length>500)throw new DraftError("TOO_MANY_INTENTS");
  if(snapshot.warnings.length)throw new DraftError("DRAFT_REQUIRES_REVIEW");
  const current=activeGeneration(snapshot),base=snapshot.head??emptyBase;
  if(current&&snapshot.head?.state==="outstanding"&&current.envelope.databaseEpoch!==day.databaseEpoch)throw new DraftError("DATABASE_EPOCH_CHANGED");
  const existing=snapshot.head?.state==="outstanding"?current?.envelope.intents??[]:[];
  let intents=[...existing];
  for(const {shiftId,hour,action} of changes){
    const refusal=hourEditRefusal(day,shiftId,hour);if(refusal)throw new DraftError(refusal);
    const prefix=`${hour.toString().padStart(2,"0")}:`,old=intents.find(i=>i.intent.shiftId===shiftId&&i.intent.quarter.startsWith(prefix));
    if(intents.some(i=>i.intent.shiftId===shiftId&&i.intent.quarter.startsWith(prefix)&&i.intent.granularity!=="hour"))throw new DraftError("QUARTER_DRAFT_REVIEW_ONLY");
    const source=old?.source??day.sources.find(s=>s.shiftId===shiftId)!;
    const readHour=day.hours.find(h=>h.shiftId===shiftId&&h.hourStart===chicagoHourStart(day.date,hour).toISOString());
    if(!readHour)throw new DraftError("SOURCE_CHANGED");
    const expectation=old?.hour??(readHour.revision===null?{shiftId,hourStart:readHour.hourStart,revision:null,legacySha256:readHour.legacySha256!}:{shiftId,hourStart:readHour.hourStart,revision:readHour.revision});
    const row:RetainedIntent={intentId:randomId(),editedAt:now,source,hour:expectation,baseWorldRevision:old?.baseWorldRevision??day.worldRevision,
      intent:{...action,shiftId,quarter:`${prefix}00`,granularity:"hour"} as PaintIntent};
    intents=[...intents.filter(i=>!(i.intent.shiftId===shiftId&&i.intent.quarter.startsWith(prefix))),row];
  }
  const outstanding=Boolean(existing.length),reviewReasons=outstanding?current?.envelope.reviewReasons??[]:[];
  const envelope=newEnvelope({databaseEpoch:day.databaseEpoch,parentGenerationId:base.generationId,parentRevision:base.localRevision,
    episodeId:outstanding?current!.envelope.episodeId:randomId(),firstDirtyAt:outstanding?current!.envelope.firstDirtyAt:now,
    firstObservedAt:outstanding?current!.envelope.firstObservedAt:now,timeProvenance:outstanding?current!.envelope.timeProvenance:"edited",
    baseWorldRevision:outstanding?current!.envelope.baseWorldRevision:day.worldRevision,intents,pendingRequestId:snapshot.head?.pendingRequestId??null,
    migratedFromV1Sha256:outstanding?current?.envelope.migratedFromV1Sha256??null:null,reviewReasons:[...reviewReasons]});
  if(intents.some(i=>i.baseWorldRevision!==envelope.baseWorldRevision))envelope.reviewReasons.push("DRAFT_BASE_REVISIONS_DIFFER");
  return {base,proposal:generation(scope,envelope)};
}
