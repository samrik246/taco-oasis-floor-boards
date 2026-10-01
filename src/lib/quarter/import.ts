import type { ParseResult } from "@/lib/parser/schedule-parser";
import type { ReconcilePlan } from "@/lib/import/reconcile";
import type { RemovalDecision } from "@/lib/import/removal-identity";
import type { ImportCommitResult } from "@/lib/import/persist-import";
import { seedAbilitiesFromPositions } from "@/lib/rules/abilities";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { chicagoHourOf } from "@/lib/hour-grid";
import { canonical,digest,quarterState,worldRevision,QuarterRefused,type QuarterDb } from "./schema";
import { hourKey,legacyHour,resolvePaintWorld,sourceSnapshot,type PaintHour } from "./world";
import { reconcileSource } from "./reconcile";
import { persistHour,recordMutation,receiptFor } from "./transaction";
import { peerHours,projectSeatNumbers,validatePaintWorld,validateObligations } from "./validation";

const ACTOR={id:"system:import-v2",name:"Import"};
const importRequest=(epoch:string,fingerprint:string)=>({operation:"import-v2",databaseEpoch:epoch,parsedFingerprint:fingerprint});
const importId=(epoch:string,fingerprint:string)=>`import-v2:${epoch}:${fingerprint}`;
export async function importReceipt(db:QuarterDb,fingerprint:string,batchId:string):Promise<ImportCommitResult|null> {
  const schema=await quarterState(db);if(!schema)return null;
  const receipt=await receiptFor(db,ACTOR.id,importId(schema.databaseEpoch,fingerprint));
  if(!receipt)return null;
  if(receipt.databaseEpoch!==schema.databaseEpoch || receipt.requestSha256!==digest(importRequest(schema.databaseEpoch,fingerprint)))throw new QuarterRefused("IMPORT_RECEIPT_MISMATCH");
  const response=JSON.parse(receipt.responseJson);
  if(response.fingerprint!==fingerprint||response.result?.importBatchId!==batchId)throw new QuarterRefused("IMPORT_RECEIPT_MISMATCH");
  return response.result;
}
export async function saveImportReceipt(db:QuarterDb,input:{fingerprint:string;filename:string;planDigest:string;revisionBefore:string;result:ImportCommitResult;now:Date}) {
  const schema=(await quarterState(db))!;
  const response={fingerprint:input.fingerprint,filename:input.filename,parserProtocol:2,initiator:"authorized-import-entry",planDigest:input.planDigest,
    dates:input.result.dates.map(d=>d.date),worldRevision:input.revisionBefore,result:input.result};
  await db.$executeRawUnsafe("INSERT INTO PaintCommandReceipt VALUES (?,?,?,?,?,?,?,?)",ACTOR.id,importId(schema.databaseEpoch,input.fingerprint),
    digest(importRequest(schema.databaseEpoch,input.fingerprint)),schema.databaseEpoch,input.revisionBefore,await worldRevision(db),canonical(response),+input.now);
}

export async function commitQuarterImport(db:QuarterDb,input:{parsed:ParseResult;filename:string;fingerprint:string;
  plan:ReconcilePlan & {removalDecisions:RemovalDecision[]};now:Date;revisionBefore:string}):Promise<ImportCommitResult> {
  const {parsed,filename,fingerprint,plan,now}=input;
  const schema=(await quarterState(db))!;
  const requestId=importId(schema.databaseEpoch,fingerprint);
  const oldWorlds=await Promise.all(plan.dates.map(d=>resolvePaintWorld(db,d.date)));
  const batch=await db.importBatch.create({data:{filename,fingerprint,rowCount:parsed.shifts.length}});
  const defaults=await loadColumnDefaults(db);
  const employees=new Map<string,string>();
  for(const s of parsed.shifts) {
    if(!employees.has(s.externalId)) {
      const person=await db.employee.upsert({where:{externalId:s.externalId},create:{externalId:s.externalId,firstName:s.firstName,lastName:s.lastName},
        update:{firstName:s.firstName,lastName:s.lastName}});
      employees.set(s.externalId,person.id);
    }
    const employeeId=employees.get(s.externalId)!;
    for(const ability of seedAbilitiesFromPositions([s.sourcePosition])) {
      const level=ability.level==="ok"&&defaults.get(ability.stationId)==="forbidden"?"forbidden":ability.level;
      await db.employeeStationAbility.upsert({where:{employeeId_stationId:{employeeId,stationId:ability.stationId}},
        create:{employeeId,stationId:ability.stationId,level},update:{}});
    }
  }
  const created=new Map<ParseResult["shifts"][number],Awaited<ReturnType<typeof db.shift.create>>>();
  for(const action of plan.actions) {
    if(action.kind==="unchanged")continue;
    if(action.kind!=="added") {
      const source=oldWorlds.find(w=>w.date===action.old.date)!.sources.find(s=>s.id===action.old.id)!;
      const replaceIdentity=action.kind==="changed"&&action.next.board!==source.board;
      const patch=action.kind==="changed"&&!replaceIdentity?{startAt:action.next.startAt,endAt:action.next.endAt}:
        {supersededAt:now,supersededByBatchId:batch.id};
      await reconcileSource(db,{shiftId:source.id,expectedSourceSha256:digest(sourceSnapshot(source)),patch,actor:ACTOR,requestId,now});
      if(action.kind==="removed"||(action.kind==="changed"&&!replaceIdentity))continue;
    }
    if("next" in action) {
      const s=action.next;
      created.set(s,await db.shift.create({data:{employeeId:employees.get(s.externalId)!,date:s.date,board:s.board,sourcePosition:s.sourcePosition,
        startAt:s.startAt,endAt:s.endAt,importBatchId:batch.id}}));
    }
  }
  // Preserve hidden-source matching and original removal event bytes, including relink tombstones.
  for(const decision of plan.removalDecisions) {
    if(decision.action==="unchanged")continue;
    const changed=plan.actions.find(a=>a.kind==="changed"&&a.next===decision.next);
    const shiftId=decision.action==="source-missing"?null:created.get(decision.next!)?.id??(changed&&"old" in changed?changed.old.id:null);
    if(decision.action!=="source-missing"&&!shiftId)throw new QuarterRefused("REMOVAL_IDENTITY_CHANGED");
    if(shiftId) {
      const s=(await db.shift.findUnique({where:{id:shiftId}}))!;
      await reconcileSource(db,{shiftId,expectedSourceSha256:digest(sourceSnapshot(s)),patch:{boardRemoved:true},actor:ACTOR,requestId,now});
    }
    const row=await db.shiftRemoval.update({where:{id:decision.overrideId},data:{shiftId,revision:{increment:1},
      ...(decision.next?{startAt:decision.next.startAt,endAt:decision.next.endAt}:{})}});
    await db.shiftRemovalEvent.create({data:{overrideId:row.id,action:decision.action,revision:row.revision,reason:"Schedule re-import",
      sourceJson:canonical({externalId:row.externalId,date:row.date,board:row.board,sourcePosition:row.sourcePosition,startAt:row.startAt.toISOString(),endAt:row.endAt.toISOString(),shiftId}),cellsJson:row.cellsJson}});
  }
  for(const action of plan.actions.filter(a=>a.kind==="takeover")) {
    if(action.kind!=="takeover")continue;
    const source=created.get(action.next)!;
    const before=await resolvePaintWorld(db,source.date);
    const after=structuredClone(before);
    const old=oldWorlds.find(w=>w.date===source.date)!;
    const touched=new Set<string>();
    const transfers:PaintHour[]=[];
    for(const origin of old.hours.filter(h=>h.shiftId===action.old.id&&h.hourStartMs>+now)) {
      const destination=legacyHour(source,origin.hourStartMs,[]);
      destination.segments=origin.segments.map(s=>({...s,id:`transfer:${source.id}:${s.startMs}`,assignmentId:undefined}));
      after.hours=after.hours.filter(h=>hourKey(h.shiftId,h.hourStartMs)!==hourKey(source.id,origin.hourStartMs));
      after.hours.push(destination);transfers.push(destination);touched.add(hourKey(source.id,origin.hourStartMs));
    }
    projectSeatNumbers(after);
    await validatePaintWorld(db,after,touched);
    await validateObligations(db,before,after,now);
    for(const h of transfers) {
      const original=legacyHour(source,h.hourStartMs,[]);
      await persistHour(db,h,now);
      await recordMutation(db,ACTOR.id,requestId,original,h,now,{operation:"import-takeover"});
    }
  }
  const fixedSkipped:NonNullable<ImportCommitResult["fixedSkipped"]>=[];
  const maps=await db.positionStationMap.findMany({where:{stationId:{not:null}},include:{station:true}});
  for(const date of plan.dates.map(d=>d.date)) {
    const before=await resolvePaintWorld(db,date);projectSeatNumbers(before);
    let staged=structuredClone(before);const touched=new Set<string>();
    const candidates=before.hours.filter(h=>{
      const s=before.sources.find(s=>s.id===h.shiftId)!;
      return !s.supersededAt&&!s.boardRemoved&&maps.some(m=>m.position===s.sourcePosition);
    }).sort((a,b)=>a.shiftId.localeCompare(b.shiftId)||a.hourStartMs-b.hourStartMs);
    for(const original of candidates) {
      const source=before.sources.find(s=>s.id===original.shiftId)!;
      const stationId=maps.find(m=>m.position===source.sourcePosition)!.stationId!;
      let reason=original.id?"ADOPTED_HOUR":original.segments.some(s=>s.state==="assigned")?"OCCUPIED_HOUR":null;
      if(!reason) {
        const proposal=structuredClone(staged);
        const hour=proposal.hours.find(h=>hourKey(h.shiftId,h.hourStartMs)===hourKey(original.shiftId,original.hourStartMs))!;
        const proposedKeys=new Set(touched);proposedKeys.add(hourKey(hour.shiftId,hour.hourStartMs));
        for(const s of hour.segments)if(s.state!=="off"){s.state="assigned";s.stationId=stationId;s.seatNumber=null;}
        try {
          peerHours(proposal,proposedKeys,[{hourStartMs:hour.hourStartMs,stationId}]);projectSeatNumbers(proposal);
          await validatePaintWorld(db,proposal,proposedKeys);await validateObligations(db,before,proposal,now);
          staged=proposal;for(const key of proposedKeys)touched.add(key);
        }catch(error){if(!(error instanceof QuarterRefused))throw error;reason=error.code;}
      }
      if(reason)fixedSkipped.push({shiftId:original.shiftId,hour:chicagoHourOf(new Date(original.hourStartMs)),reason});
    }
    for(const h of staged.hours.filter(h=>touched.has(hourKey(h.shiftId,h.hourStartMs)))) {
      const original=before.hours.find(o=>hourKey(o.shiftId,o.hourStartMs)===hourKey(h.shiftId,h.hourStartMs))!;
      if(h.id&&canonical(h.segments)===canonical(original.segments))continue;
      await persistHour(db,h,now);await recordMutation(db,ACTOR.id,requestId,original,h,now,{operation:"import-fixed"});
    }
    await resolvePaintWorld(db,date);
  }
  fixedSkipped.sort((a,b)=>a.shiftId.localeCompare(b.shiftId)||a.hour-b.hour||a.reason.localeCompare(b.reason));
  const result={importBatchId:batch.id,rowCount:parsed.shifts.length,dates:plan.dates,fixedSkipped};
  await saveImportReceipt(db,{fingerprint,filename,planDigest:plan.digest,revisionBefore:input.revisionBefore,result,now});
  return result;
}
