import { z } from "zod";
import { prisma } from "@/lib/db";
import { canonical,digest,QuarterRefused,quarterState,worldRevision,CAPABILITY_SHA256 } from "./schema";
import { resolvePaintWorld,sourceSnapshot,hourKey,legacyHour,assertPartition,type PaintHour } from "./world";
import { reconcileSource } from "./reconcile";
import { quarterWrite,receiptFor,persistHour,replaceHourSegments,recordMutation,type CommandActor } from "./transaction";
import { validatePaintWorld,validateObligations,projectSeatNumbers,peerHours } from "./validation";

const removalBase={protocol:z.literal(2),requestId:z.string().min(1).max(160),capabilitySha256:z.string(),date:z.iso.date(),board:z.enum(["caja","cocina"]),reason:z.string().trim().min(1).max(2000)};
const removalExpected=z.strictObject({databaseEpoch:z.string(),worldRevision:z.string(),sourceSha256:z.string(),removalRevision:z.number().int().nonnegative()});
export const removalCommandSchema=z.discriminatedUnion("operation",[
  z.strictObject({...removalBase,expected:removalExpected,shiftId:z.string().min(1),operation:z.literal("remove"),positions:z.enum(["replay","none"]).optional()}),
  z.strictObject({...removalBase,expected:removalExpected,shiftId:z.string().min(1),operation:z.literal("restore"),positions:z.enum(["replay","none"]).optional()}),
  z.strictObject({...removalBase,expected:removalExpected.omit({sourceSha256:true}),removalId:z.string().min(1),operation:z.literal("resolve")}),
]);
type Snapshot={version:2;source:ReturnType<typeof sourceSnapshot>;hours:{before:PaintHour;postRevision:string|null}[]};

export async function removeRestoreV2(raw:unknown,actor:CommandActor,now=new Date(),client=prisma) {
  const command=removalCommandSchema.parse(raw);
  return quarterWrite(client,async db=>{
    if(command.operation==="restore"&&!command.positions)throw new QuarterRefused("RESTORE_REQUIRES_REVIEW");
    const hash=digest(command),prior=await receiptFor(db,actor.id,command.requestId);
    if(prior){if(prior.requestSha256!==hash||prior.databaseEpoch!==command.expected.databaseEpoch)throw new QuarterRefused("REQUEST_ID_REUSE");return JSON.parse(prior.responseJson);}
    const schema=await quarterState(db);
    if(schema?.phase!=="active")throw new QuarterRefused("QUARTER_NOT_ACTIVE");
    if(command.capabilitySha256!==CAPABILITY_SHA256)throw new QuarterRefused("CAPABILITY_CHANGED");
    if(schema.databaseEpoch!==command.expected.databaseEpoch||await worldRevision(db)!==command.expected.worldRevision)throw new QuarterRefused("REVISION_CONFLICT");
    if(command.operation==="resolve"){
      const override=await db.shiftRemoval.findUnique({where:{id:command.removalId}});
      if(!override||override.date!==command.date||override.board!==command.board||override.state!=="removed"||override.shiftId!==null||override.revision!==command.expected.removalRevision)throw new QuarterRefused("REMOVAL_CHANGED");
      const updated=await db.shiftRemoval.update({where:{id:override.id},data:{state:"resolved",revision:{increment:1}}});
      await db.shiftRemovalEvent.create({data:{overrideId:updated.id,action:"resolve",revision:updated.revision,managerId:actor.id,managerName:actor.name,reason:command.reason,
        sourceJson:canonical({shiftId:null,date:updated.date,board:updated.board,startAt:updated.startAt,endAt:updated.endAt}),cellsJson:updated.cellsJson}});
      const response={dates:[command.date],ok:true,id:updated.id,revision:updated.revision,state:updated.state,requestId:command.requestId,requestSha256:hash,databaseEpoch:schema.databaseEpoch,committedRevision:await worldRevision(db),refreshRequired:true};
      await db.$executeRawUnsafe("INSERT INTO PaintCommandReceipt VALUES (?,?,?,?,?,?,?,?)",actor.id,command.requestId,hash,schema.databaseEpoch,command.expected.worldRevision,response.committedRevision,canonical(response),+now);return response;
    }
    const source=await db.shift.findUnique({where:{id:command.shiftId},include:{employee:{select:{externalId:true}},removalOverride:true}});
    if(!source||source.date!==command.date||source.board!==command.board||source.supersededAt||digest(sourceSnapshot(source))!==command.expected.sourceSha256)throw new QuarterRefused("SOURCE_CHANGED");
    const override=source.removalOverride;
    if((override?.revision??0)!==command.expected.removalRevision)throw new QuarterRefused("REMOVAL_CHANGED");
    const before=await resolvePaintWorld(db,command.date);
    let cellsJson:string;
    if(command.operation==="remove") {
      if(source.boardRemoved||override?.state==="removed")throw new QuarterRefused("SOURCE_CHANGED");
      const result=await reconcileSource(db,{shiftId:source.id,expectedSourceSha256:command.expected.sourceSha256,patch:{boardRemoved:true},actor,requestId:command.requestId,now});
      const snapshot:Snapshot={version:2,source:sourceSnapshot(source),hours:result.before.filter(h=>h.hourStartMs>+now).map(h=>({before:h,
        postRevision:result.after.find(a=>a.hourStartMs===h.hourStartMs)!.revision!}))};
      cellsJson=canonical(snapshot);
    } else {
      if(!source.boardRemoved||override?.state!=="removed")throw new QuarterRefused("RESTORE_REQUIRES_REVIEW");
      let snapshot:Snapshot;
      try{snapshot=JSON.parse(override.cellsJson);}catch{throw new QuarterRefused("RESTORE_REQUIRES_REVIEW");}
      if(Array.isArray(snapshot)) {
        const cells=z.array(z.object({id:z.string(),stationId:z.string(),hourStart:z.iso.datetime(),hourEnd:z.iso.datetime()})).safeParse(snapshot);
        if(!cells.success || override.date!==source.date || override.board!==source.board || override.sourcePosition!==source.sourcePosition ||
          +override.startAt!==+source.startAt || +override.endAt!==+source.endAt)throw new QuarterRefused("RESTORE_REQUIRES_REVIEW");
        const hours:Snapshot["hours"]=[];
        for(const cell of cells.data){
          const start=+new Date(cell.hourStart),current=before.hours.find(h=>h.shiftId===source.id&&h.hourStartMs===start);
          if(!current||current.id||current.segments.some(s=>s.state==="assigned")||+new Date(cell.hourEnd)!==start+3600000)throw new QuarterRefused("RESTORE_REQUIRES_REVIEW");
          const h=legacyHour({...source,boardRemoved:false},start,[]);
          for(const s of h.segments)if(s.state!=="off"){s.state="assigned";s.stationId=cell.stationId;}
          hours.push({before:h,postRevision:null});
        }
        snapshot={version:2,source:sourceSnapshot({...source,boardRemoved:false}),hours};
      }
      if(snapshot.version!==2||!Array.isArray(snapshot.hours)||canonical({...snapshot.source,boardRemoved:true})!==canonical(sourceSnapshot(source)))
        throw new QuarterRefused("RESTORE_REQUIRES_REVIEW");
      try {
        for(const saved of snapshot.hours){
          if(!saved.before || !Array.isArray(saved.before.segments) || !(saved.postRevision===null||/^[1-9][0-9]*$/.test(saved.postRevision)))throw new Error("invalid snapshot");
          assertPartition(saved.before,{...source,boardRemoved:false});
        }
      }catch{throw new QuarterRefused("RESTORE_REQUIRES_REVIEW");}
      for(const saved of snapshot.hours){const current=before.hours.find(h=>h.shiftId===source.id&&h.hourStartMs===saved.before.hourStartMs);
        if(!current||current.revision!==saved.postRevision)throw new QuarterRefused("RESTORE_REQUIRES_REVIEW");}
      await reconcileSource(db,{shiftId:source.id,expectedSourceSha256:command.expected.sourceSha256,patch:{boardRemoved:false},actor,requestId:command.requestId,now});
      if(command.positions==="replay") {
        const world=await resolvePaintWorld(db,command.date),after=structuredClone(world),touched=new Set<string>();
        for(const saved of snapshot.hours.filter(h=>h.before.hourStartMs>+now)) {
          const hour=after.hours.find(h=>h.shiftId===source.id&&h.hourStartMs===saved.before.hourStartMs)!;
          hour.segments=structuredClone(saved.before.segments);touched.add(hourKey(hour.shiftId,hour.hourStartMs));
        }
        projectSeatNumbers(world);
        const targets=after.hours.filter(h=>touched.has(hourKey(h.shiftId,h.hourStartMs))).flatMap(h=>h.segments.flatMap(s=>s.stationId?[{hourStartMs:h.hourStartMs,stationId:s.stationId}]:[]));
        peerHours(world,touched,targets);
        for(const h of after.hours.filter(h=>h.shiftId!==source.id))h.segments=structuredClone(world.hours.find(p=>hourKey(p.shiftId,p.hourStartMs)===hourKey(h.shiftId,h.hourStartMs))!.segments);
        await validatePaintWorld(db,after,touched);projectSeatNumbers(after);await validatePaintWorld(db,after,touched);await validateObligations(db,world,after,now);
        for(const h of after.hours.filter(h=>touched.has(hourKey(h.shiftId,h.hourStartMs)))){
          const original=world.hours.find(o=>hourKey(o.shiftId,o.hourStartMs)===hourKey(h.shiftId,h.hourStartMs))!;
          // Source reconciliation already advanced this command's revision. Replace exact
          // segments inside the same transaction without incrementing it a second time.
          if(h.shiftId===source.id)await replaceHourSegments(db,h);
          else await persistHour(db,h,now);
          await recordMutation(db,actor.id,command.requestId,original,h,now,{operation:"restore",reason:command.reason});
        }
      }
      cellsJson=override.cellsJson;
    }
    const data={shiftId:source.id,externalId:source.employee.externalId,date:source.date,board:source.board,sourcePosition:source.sourcePosition,
      startAt:source.startAt,endAt:source.endAt,state:command.operation==="remove"?"removed":"restored",cellsJson};
    const row=override?await db.shiftRemoval.update({where:{id:override.id},data:{...data,revision:{increment:1}}}):await db.shiftRemoval.create({data});
    await db.shiftRemovalEvent.create({data:{overrideId:row.id,action:command.operation,revision:row.revision,managerId:actor.id,managerName:actor.name,
      reason:command.reason,sourceJson:canonical(sourceSnapshot(source)),cellsJson}});
    await resolvePaintWorld(db,command.date);
    const response={dates:[command.date],ok:true,id:row.id,revision:row.revision,requestId:command.requestId,requestSha256:hash,databaseEpoch:schema.databaseEpoch,committedRevision:await worldRevision(db),refreshRequired:true};
    await db.$executeRawUnsafe("INSERT INTO PaintCommandReceipt VALUES (?,?,?,?,?,?,?,?)",actor.id,command.requestId,hash,schema.databaseEpoch,command.expected.worldRevision,response.committedRevision,canonical(response),+now);
    return response;
  });
}
