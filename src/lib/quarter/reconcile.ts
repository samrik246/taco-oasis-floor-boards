import { canonical, digest, QuarterRefused, type QuarterDb } from "./schema";
import { HOUR_MS, hourKey, legacyHour, overlaps, resolvePaintWorld, sourceSnapshot, type PaintHour, type Source } from "./world";
import { persistHour, recordMutation, type CommandActor } from "./transaction";
import { projectSeatNumbers, validatePaintWorld } from "./validation";
import { chicagoHourStart, hourGridHours } from "@/lib/hour-grid";

/** Source identity never changes. New factual minutes are erased; prior clips never grow. */
export function reconcilePartition(old:PaintHour, source:Source, now:Date):PaintHour {
  const next=legacyHour(source,old.hourStartMs,[]);
  next.id=old.id;next.revision=old.revision;next.legacyJson=old.legacyJson;next.legacySha256=old.legacySha256;
  const segments:PaintHour["segments"]=[];
  for(const s of next.segments) {
    const bounds=[...new Set([s.startMs,s.endMs,...old.segments.flatMap(o=>[o.startMs,o.endMs]).filter(t=>t>s.startMs&&t<s.endMs)])].sort((a,b)=>a-b);
    for(let i=1;i<bounds.length;i++) {
      const startMs=bounds[i-1],endMs=bounds[i];
      const prior=old.segments.find(o=>o.startMs<=startMs&&o.endMs>=endMs);
      const drop=(source.supersededAt!==null||source.boardRemoved)&&old.hourStartMs>+now;
      segments.push({...s,startMs,endMs,...(s.state!=="off" && prior?.state==="assigned" && !drop?
        {state:"assigned",stationId:prior.stationId,seatNumber:prior.seatNumber}:{} )});
    }
  }
  next.segments=segments;
  if(old.hourStartMs<=+now) {
    // Changed timing may not retroactively trim a started painted hour. Import must replace
    // the source instead; superseding its status still preserves that original factual window.
    for(const s of old.segments.filter(s=>s.state==="assigned")) {
      const covered=next.segments.filter(n=>n.state==="assigned"&&n.stationId===s.stationId&&overlaps(n,s))
        .reduce((sum,n)=>sum+Math.min(n.endMs,s.endMs)-Math.max(n.startMs,s.startMs),0);
      if(covered!==s.endMs-s.startMs)throw new QuarterRefused("SOURCE_REPLACEMENT_REQUIRED");
    }
  }
  return next;
}

export async function reconcileSource(db:QuarterDb,input:{shiftId:string;expectedSourceSha256:string;
  patch:{startAt?:Date;endAt?:Date;supersededAt?:Date|null;boardRemoved?:boolean;supersededByBatchId?:string|null};actor:CommandActor;requestId:string;now:Date}) {
  const stored=await db.shift.findUnique({where:{id:input.shiftId}});
  if(!stored)throw new QuarterRefused("SOURCE_CHANGED");
  const before=await resolvePaintWorld(db,stored.date);
  if(before.state?.phase!=="active")throw new QuarterRefused("QUARTER_NOT_ACTIVE");
  if(digest(sourceSnapshot(stored))!==input.expectedSourceSha256)throw new QuarterRefused("SOURCE_CHANGED");
  const next:Source={...stored,...input.patch};
  if(+next.endAt<=+next.startAt)throw new QuarterRefused("INVALID_SHIFT_WINDOW",422);
  const obligations=await db.staffBreak.findMany({where:{date:stored.date,status:"booked",endAt:{gt:input.now},
    OR:[{shiftId:stored.id},{coverShiftId:stored.id},{shuffleShiftId:stored.id}]}});
  if(obligations.some(b=>next.supersededAt||next.boardRemoved||next.startAt>b.startAt||next.endAt<b.endAt))throw new QuarterRefused("PERSISTED_COVER_CONFLICT");
  const overlays=await db.boardOverlay.findMany({where:{date:stored.date,cancelledAt:null,endAt:{gt:input.now},
    OR:[{employeeId:stored.employeeId},{partnerEmployeeId:stored.employeeId}]}});
  if(overlays.some(o=>next.supersededAt||next.boardRemoved||next.startAt>o.startAt||next.endAt<o.endAt))throw new QuarterRefused("OVERLAY_CONFLICT");
  const after=structuredClone(before);
  after.sources=after.sources.map(s=>s.id===stored.id?next:s);
  projectSeatNumbers(before);
  const oldHours=before.hours.filter(h=>h.shiftId===stored.id);
  const starts=new Set(oldHours.map(h=>h.hourStartMs));
  for(const wallHour of hourGridHours()) {
    const start=+chicagoHourStart(stored.date,wallHour);
    if(+next.startAt<start+HOUR_MS&&+next.endAt>start)starts.add(start);
  }
  const changed:PaintHour[]=[];
  for(const start of [...starts].sort((a,b)=>a-b)) {
    const old=oldHours.find(h=>h.hourStartMs===start)??legacyHour(stored,start,[]);
    changed.push(reconcilePartition(old,next,input.now));
  }
  if(changed.length>500)throw new QuarterRefused("TOO_MANY_HOURS",413);
  after.hours=[...after.hours.filter(h=>h.shiftId!==stored.id),...changed];
  const touched=new Set(changed.map(h=>hourKey(h.shiftId,h.hourStartMs)));
  await validatePaintWorld(db,after,touched);
  for(const h of changed) {
    const old=oldHours.find(o=>o.hourStartMs===h.hourStartMs)??legacyHour(stored,h.hourStartMs,[]);
    await persistHour(db,h,input.now);
    await recordMutation(db,input.actor.id,input.requestId,old,h,input.now,{operation:"source-reconcile"});
  }
  // All snapshots are staged first. SQL guards independently verify every adopted source hour.
  await db.shift.update({where:{id:stored.id},data:input.patch});
  await resolvePaintWorld(db,stored.date);
  return {before:oldHours,after:changed,sourceJson:canonical(sourceSnapshot(next))};
}
