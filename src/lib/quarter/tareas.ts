import { z } from "zod";
import { prisma } from "@/lib/db";
import { assignTarea,setTareaStatus } from "@/lib/tareas/service";
import { quarterWrite,receiptFor,type CommandActor } from "./transaction";
import { CAPABILITY_SHA256,QuarterRefused,quarterState,worldRevision,canonical,digest } from "./schema";
import { quarterInstant } from "./protocol";
const base={protocol:z.literal(2),requestId:z.string().min(1).max(160),capabilitySha256:z.string(),date:z.iso.date(),
  expected:z.strictObject({databaseEpoch:z.string(),worldRevision:z.string().regex(/^(0|[1-9][0-9]*)$/)})};
export const tareaCommandSchema=z.discriminatedUnion("operation",[
  z.strictObject({...base,operation:z.literal("assign"),employeeId:z.string().min(1),templateId:z.string().min(1),quarter:z.string(),granularity:z.enum(["hour","quarter"]),forceLemon:z.boolean().optional()}),
  z.strictObject({...base,operation:z.literal("status"),id:z.string().min(1),status:z.enum(["working","done"])}),
]);
/** The task and its original-revision receipt commit together. A return never reconstructs paint. */
export async function tareaV2(raw:unknown,actor:CommandActor,now=new Date(),client=prisma) {
  const command=tareaCommandSchema.parse(raw);
  return quarterWrite(client,async db=>{
    const hash=digest(command),prior=await receiptFor(db,actor.id,command.requestId);
    if(prior){if(prior.requestSha256!==hash||prior.databaseEpoch!==command.expected.databaseEpoch)throw new QuarterRefused("REQUEST_ID_REUSE");return JSON.parse(prior.responseJson);}
    const schema=await quarterState(db);
    if(schema?.phase!=="active")throw new QuarterRefused("QUARTER_NOT_ACTIVE");
    if(command.capabilitySha256!==CAPABILITY_SHA256)throw new QuarterRefused("CAPABILITY_CHANGED");
    if(schema.databaseEpoch!==command.expected.databaseEpoch||await worldRevision(db)!==command.expected.worldRevision)throw new QuarterRefused("REVISION_CONFLICT");
    let assignment;
    if(command.operation==="assign"){
      const startMs=quarterInstant(command.date,command.quarter),endMs=startMs+(command.granularity==="hour"?3600000:900000);
      if(command.granularity==="hour"&&!command.quarter.endsWith(":00"))throw new QuarterRefused("INVALID_HOUR",422);
      const result=await assignTarea({db,date:command.date,employeeId:command.employeeId,templateId:command.templateId,hour:Number(command.quarter.slice(0,2)),forceLemon:command.forceLemon,
        interval:{startAt:new Date(startMs).toISOString(),endAt:new Date(endMs).toISOString(),...command.expected}});
      if(!result.ok)throw new QuarterRefused(result.code??"TAREA_REFUSED",result.status);
      assignment=result.assignment;
    }else{
      const stored=await db.tareaAssignment.findUnique({where:{id:command.id},select:{date:true}});
      if(!stored||stored.date!==command.date)throw new QuarterRefused("TAREA_NOT_FOUND",404);
      assignment=await setTareaStatus({db,id:command.id,status:command.status});
    }
    const response={ok:true,dates:[command.date],requestId:command.requestId,requestSha256:hash,databaseEpoch:schema.databaseEpoch,
      committedRevision:await worldRevision(db),assignment:assignment?JSON.parse(JSON.stringify(assignment)):null,refreshRequired:true};
    await db.$executeRawUnsafe("INSERT INTO PaintCommandReceipt VALUES (?,?,?,?,?,?,?,?)",actor.id,command.requestId,hash,schema.databaseEpoch,command.expected.worldRevision,response.committedRevision,canonical(response),+now);
    await db.boardChangeLog.create({data:{managerId:actor.id,managerName:actor.name,date:command.date,route:"POST /api/v2/tareas",summary:`${command.operation} request=${command.requestId} task=${assignment?.id}`}});
    return response;
  });
}
