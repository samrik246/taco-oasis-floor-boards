import { CAPABILITY_SHA256,QuarterRefused,digest,quarterState,worldRevision,type QuarterDb } from "./schema";
import { sourceSnapshot } from "./world";
import { z } from "zod";
const cell=z.object({id:z.string().optional(),stationId:z.string(),hourStart:z.string(),hourEnd:z.string()});
const snapshot=z.object({version:z.literal(2),hours:z.array(z.object({before:z.object({segments:z.array(z.object({state:z.string(),stationId:z.string().nullable(),startMs:z.number(),endMs:z.number()}))})}))});
/** Authorized history projects factual bounds only, never internal source/legacy JSON. */
function cells(raw:string){
  const value:unknown=JSON.parse(raw),v2=snapshot.safeParse(value);
  if(v2.success)return v2.data.hours.flatMap(h=>h.before.segments.flatMap(s=>s.state==="assigned"&&s.stationId?[{stationId:s.stationId,hourStart:new Date(s.startMs).toISOString(),hourEnd:new Date(s.endMs).toISOString()}]:[]));
  return z.array(cell).parse(Array.isArray(value)?value:(value as {cells:unknown}).cells);
}
function source(raw:string){
  const value=JSON.parse(raw);
  return {startAt:value.startAt??(value.startAtMs?new Date(value.startAtMs).toISOString():null),endAt:value.endAt??(value.endAtMs?new Date(value.endAtMs).toISOString():null)};
}
export async function readRemovalReview(db:QuarterDb,board:"caja"|"cocina",date:string,actorId:string){
  const state=await quarterState(db);if(state?.phase!=="active")throw new QuarterRefused("QUARTER_NOT_ACTIVE");
  const shifts=await db.shift.findMany({where:{date,board},include:{removalOverride:true}});
  const rows=await db.shiftRemoval.findMany({where:{date,board},include:{shift:true,events:{orderBy:{revision:"asc"}}},orderBy:{createdAt:"asc"}});
  return {actorId,snapshot:{databaseEpoch:state.databaseEpoch,worldRevision:await worldRevision(db),phase:state.phase,capabilitySha256:CAPABILITY_SHA256},
    sources:shifts.filter(s=>!s.supersededAt).map(s=>({shiftId:s.id,sourceSha256:digest(sourceSnapshot(s)),removalRevision:s.removalOverride?.revision??0})),
    removals:rows.map(r=>{
      const saved=cells(r.cellsJson);
      return {id:r.id,shiftId:r.shiftId,externalId:r.externalId,date:r.date,board:r.board,sourcePosition:r.sourcePosition,startAt:r.startAt.toISOString(),endAt:r.endAt.toISOString(),state:r.state,revision:r.revision,
        savedCells:saved.length,savedMinutes:saved.reduce((n,c)=>n+(Date.parse(c.hourEnd)-Date.parse(c.hourStart))/60000,0),
        currentSource:r.shift&&!r.shift.supersededAt?{startAt:r.shift.startAt.toISOString(),endAt:r.shift.endAt.toISOString(),employeeId:r.shift.employeeId,sourcePosition:r.shift.sourcePosition}:null,
        events:r.events.map(e=>({action:e.action,revision:e.revision,managerName:e.managerName,reason:e.reason,createdAt:e.createdAt.toISOString(),source:source(e.sourceJson),cells:cells(e.cellsJson)}))};
    })};
}
