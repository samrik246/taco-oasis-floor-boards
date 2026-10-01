import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { prisma } from "@/lib/db";
import { TIMEZONE } from "@/lib/constants";
import { chicagoHourStart } from "@/lib/hour-grid";
import { paintCommandSchema, sourceExpectation, hourExpectation, quarterInstant, type PaintIntent, type PaintCommand } from "./protocol";
import { CAPABILITY_SHA256, QuarterRefused, digest, canonical, worldRevision } from "./schema";
import { quarterWrite, applyPaintCommand, receiptFor, checkExpectations, persistHour, recordMutation, type CommandActor, type PaintReceipt } from "./transaction";
import { resolvePaintWorld, hourKey, overlaps, HOUR_MS, type Segment } from "./world";
import { projectSeatNumbers, peerHours, validatePaintWorld, validateObligations } from "./validation";

const envelope=paintCommandSchema.omit({intents:true});
const reason={reason:z.string().max(200).optional(),moveNote:z.string().max(2000).nullable().optional()};
export const operationSchema=z.discriminatedUnion("operation",[
  envelope.extend({operation:z.literal("whole-shift"),shiftId:z.string().min(1),stationId:z.string().min(1).nullable(),...reason}),
  envelope.extend({operation:z.literal("swap"),leftShiftId:z.string().min(1),rightShiftId:z.string().min(1),quarter:z.string(),granularity:z.enum(["hour","quarter"]),...reason}),
  envelope.extend({operation:z.literal("copy"),sourceDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),sourceSources:z.array(sourceExpectation),sourceHours:z.array(hourExpectation),
    mode:z.enum(["preview","commit"]),previewSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
    mapping:z.array(z.strictObject({fromShiftId:z.string().min(1),toShiftId:z.string().min(1)})).min(1).max(500)}),
]);
export type QuarterOperation=z.infer<typeof operationSchema>;

/** Whole-shift/swap/copy adapters retain the caller's original expectations, never refresh them. */
export async function operateV2(input:unknown,actor:CommandActor,now=new Date(),client=prisma) {
  if(Buffer.byteLength(canonical(input))>2*1024*1024)throw new QuarterRefused("REQUEST_TOO_LARGE",413);
  const op=operationSchema.parse(input);
  return quarterWrite(client,async db=>{
    const hash=digest(op), prior=await receiptFor(db,actor.id,op.requestId);
    if(prior){if(prior.requestSha256!==hash||prior.databaseEpoch!==op.expected.databaseEpoch)throw new QuarterRefused("REQUEST_ID_REUSE");return JSON.parse(prior.responseJson) as PaintReceipt;}
    if(op.capabilitySha256!==CAPABILITY_SHA256)throw new QuarterRefused("CAPABILITY_CHANGED");
    const before=await resolvePaintWorld(db,op.date);checkExpectations(op,before);
    const base={protocol:op.protocol,requestId:op.requestId,capabilitySha256:op.capabilitySha256,board:op.board,date:op.date,expected:op.expected,
      sources:op.sources,hours:op.hours,...(op.draftSubmission?{draftSubmission:op.draftSubmission}:{})};
    if(op.operation!=="copy") {
      const intents:PaintIntent[]=[];
      if(op.operation==="whole-shift") {
        const hours=before.hours.filter(h=>h.shiftId===op.shiftId&&h.segments.some(s=>s.state!=="off"));
        if(!hours.length)throw new QuarterRefused("SOURCE_CHANGED");
        for(const h of hours)intents.push({shiftId:op.shiftId,quarter:formatInTimeZone(h.hourStartMs,TIMEZONE,"HH:mm"),granularity:"hour",
          reason:op.reason,moveNote:op.moveNote,...(op.stationId?{action:"station",stationId:op.stationId}:{action:"erase"})});
      } else {
        const startMs=quarterInstant(op.date,op.quarter),endMs=startMs+(op.granularity==="hour"?HOUR_MS:900000);
        if(op.leftShiftId===op.rightShiftId)throw new QuarterRefused("INVALID_SWAP",422);
        const ids=[op.leftShiftId,op.rightShiftId];
        const destinations=ids.map(id=>{
          const source=before.sources.find(s=>s.id===id);
          if(!source||+source.startAt>startMs||+source.endAt<endMs)throw new QuarterRefused("SWAP_WINDOW",422);
          const segments=before.hours.filter(h=>h.shiftId===id).flatMap(h=>h.segments).filter(s=>overlaps(s,{startMs,endMs}));
          const stations=new Set(segments.map(s=>s.stationId));
          if(stations.size!==1||stations.has(null))throw new QuarterRefused("HOUR_NEEDS_QUARTER");
          return [...stations][0]!;
        });
        ids.forEach((shiftId,index)=>intents.push({shiftId,quarter:op.quarter,granularity:op.granularity,reason:op.reason,moveNote:op.moveNote,
          action:"station",stationId:destinations[1-index]}));
      }
      const command:PaintCommand={...base,intents};
      return applyPaintCommand(db,paintCommandSchema.parse(command),actor,now,op);
    }
    const source=await resolvePaintWorld(db,op.sourceDate);
    checkExpectations({expected:op.expected,sources:op.sourceSources,hours:op.sourceHours},source);
    if(op.sourceDate===op.date)throw new QuarterRefused("COPY_SAME_DAY",422);
    const after=structuredClone(before), touched=new Set<string>();
    const usedFrom=new Set<string>(),usedTo=new Set<string>();
    let clippedMs=0;
    for(const mapping of op.mapping) {
      if(usedFrom.has(mapping.fromShiftId)||usedTo.has(mapping.toShiftId))throw new QuarterRefused("COPY_AMBIGUOUS_SOURCE",422);
      usedFrom.add(mapping.fromShiftId);usedTo.add(mapping.toShiftId);
      const from=source.sources.find(s=>s.id===mapping.fromShiftId),to=after.sources.find(s=>s.id===mapping.toShiftId);
      if(!from||!to||from.board!==op.board||to.board!==op.board||!op.sourceSources.some(s=>s.shiftId===from.id)||!op.sources.some(s=>s.shiftId===to.id))throw new QuarterRefused("SOURCE_CHANGED");
      for(const sourceHour of source.hours.filter(h=>h.shiftId===from.id)) {
        if(!op.sourceHours.some(h=>h.shiftId===from.id&&+new Date(h.hourStart)===sourceHour.hourStartMs))throw new QuarterRefused("MISSING_EXPECTATION",422);
        const clock=Number(formatInTimeZone(sourceHour.hourStartMs,TIMEZONE,"H"));
        const targetStart=+chicagoHourStart(op.date,clock),delta=targetStart-sourceHour.hourStartMs;
        const destination=after.hours.find(h=>h.shiftId===to.id&&h.hourStartMs===targetStart);
        if(!destination) {clippedMs+=sourceHour.segments.filter(s=>s.state==="assigned").reduce((n,s)=>n+s.endMs-s.startMs,0);continue;}
        if(destination.id||destination.segments.some(s=>s.state==="assigned"))throw new QuarterRefused("COPY_TARGET_NOT_EMPTY");
        if(!op.hours.some(h=>h.shiftId===to.id&&+new Date(h.hourStart)===targetStart))throw new QuarterRefused("MISSING_EXPECTATION",422);
        const segments:Segment[]=[];
        for(const d of destination.segments) {
          const boundaries=[...new Set([d.startMs,d.endMs,...sourceHour.segments.flatMap(s=>[s.startMs+delta,s.endMs+delta]).filter(t=>t>d.startMs&&t<d.endMs)])].sort((a,b)=>a-b);
          for(let i=1;i<boundaries.length;i++){
            const startMs=boundaries[i-1],endMs=boundaries[i];
            const old=sourceHour.segments.find(s=>s.startMs+delta<=startMs&&s.endMs+delta>=endMs);
            segments.push({...d,startMs,endMs,...(d.state!=="off"&&old?.state==="assigned"?{state:"assigned",stationId:old.stationId,seatNumber:null}:{})});
          }
        }
        const copied=segments.filter(s=>s.state==="assigned").reduce((n,s)=>n+s.endMs-s.startMs,0);
        clippedMs+=sourceHour.segments.filter(s=>s.state==="assigned").reduce((n,s)=>n+s.endMs-s.startMs,0)-copied;
        destination.segments=segments;touched.add(hourKey(to.id,targetStart));
      }
    }
    const targets=after.hours.filter(h=>touched.has(hourKey(h.shiftId,h.hourStartMs))).flatMap(h=>h.segments.flatMap(s=>s.stationId?[{hourStartMs:h.hourStartMs,stationId:s.stationId}]:[]));
    peerHours(after,touched,targets);projectSeatNumbers(after);
    await validatePaintWorld(db,after,touched);await validateObligations(db,before,after,now);
    const changed=after.hours.filter(h=>touched.has(hourKey(h.shiftId,h.hourStartMs)));
    const preview={clippedMinutes:clippedMs/60_000,expected:op.expected,mapping:op.mapping,
      intervals:changed.map(h=>({shiftId:h.shiftId,hourStart:new Date(h.hourStartMs).toISOString(),segments:h.segments.map(({startMs,endMs,state,stationId,seatNumber})=>({startMs,endMs,state,stationId,seatNumber}))}))};
    const previewSha256=digest(preview);
    if(op.mode==="preview")return {ok:true,preview:true,previewSha256,...preview};
    if(op.previewSha256!==previewSha256)throw new QuarterRefused("COPY_PREVIEW_CHANGED");
    for(const h of changed){const original=before.hours.find(o=>hourKey(o.shiftId,o.hourStartMs)===hourKey(h.shiftId,h.hourStartMs))!;
      await persistHour(db,h,now);await recordMutation(db,actor.id,op.requestId,original,h,now,{operation:"copy"});}
    await resolvePaintWorld(db,op.date);
    const response={dates:[op.date,op.sourceDate],ok:true as const,requestId:op.requestId,requestSha256:hash,databaseEpoch:op.expected.databaseEpoch,committedRevision:await worldRevision(db),
      ...(op.draftSubmission?{draftSubmission:op.draftSubmission}:{}),previewSha256,clippedMinutes:clippedMs/60_000,hours:changed.map(h=>({shiftId:h.shiftId,hourStart:new Date(h.hourStartMs).toISOString(),revision:h.revision!})),refreshRequired:true as const};
    await db.$executeRawUnsafe("INSERT INTO PaintCommandReceipt VALUES (?,?,?,?,?,?,?,?)",actor.id,op.requestId,hash,op.expected.databaseEpoch,op.expected.worldRevision,response.committedRevision,canonical(response),+now);
    return response;
  });
}
