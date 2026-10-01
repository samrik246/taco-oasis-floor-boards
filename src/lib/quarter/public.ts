import type { QuarterDb } from "./schema";
import { CAPABILITY_SHA256 } from "./schema";
import { assignedIntervals, resolvePaintWorld, type PaintWorld } from "./world";
import { projectCoverDisplay } from "@/lib/board/cover-display";

/** Safe names and saved movement share the caller's canonical snapshot. No abilities or credentials. */
export async function quarterCoverDisplay(db:QuarterDb, world:PaintWorld, board:string, now:Date) {
  const names=await db.employee.findMany({where:{id:{in:world.sources.map(s=>s.employeeId)}},select:{id:true,firstName:true,lastName:true}});
  const byId=new Map(names.map(n=>[n.id,n]));
  const intervals=assignedIntervals(world,false);
  const bookings=await db.staffBreak.findMany({where:{date:world.date,status:"booked"},select:{id:true,employeeId:true,shiftId:true,board:true,date:true,status:true,
    startAt:true,endAt:true,coverEmployeeId:true,coverShiftId:true,shuffleEmployeeId:true,shuffleShiftId:true,auto:true}});
  const overlays=await db.boardOverlay.findMany({where:{date:world.date},orderBy:[{createdAt:"desc"},{id:"desc"}],select:{board:true,kind:true,employeeId:true,partnerEmployeeId:true,
    stationId:true,fromStationId:true,startAt:true,endAt:true,cancelledAt:true}});
  return projectCoverDisplay({board,date:world.date,now,stations:world.stations,bookings,overlays,shifts:world.sources.map(s=>({...s,
    employee:{firstName:byId.get(s.employeeId)?.firstName??"",lastName:byId.get(s.employeeId)?.lastName??""},
    // Private adapter accepts exact bounds; these are not exposed as Assignment DTOs.
    assignments:intervals.filter(a=>a.shiftId===s.id).map(a=>({stationId:a.stationId!,hourStart:new Date(a.startMs),hourEnd:new Date(a.endMs)})),
  }))});
}
export async function readQuarterDay(db:QuarterDb, board:string, date:string, now=new Date()) {
  const world=await resolvePaintWorld(db,date);
  const employees=await db.employee.findMany({where:{id:{in:world.sources.map(s=>s.employeeId)}},select:{id:true,firstName:true,lastName:true}});
  return {schemaVersion:2,databaseEpoch:world.state?.databaseEpoch??null,worldRevision:world.revision,phase:world.state?.phase??"legacy",
    capabilitySha256:CAPABILITY_SHA256,board,date,
    employees:employees.map(e=>({id:e.id,firstName:e.firstName,lastName:e.lastName})),
    stations:world.stations.filter(s=>s.board===board).map(s=>({id:s.id,label:s.label,color:s.color,maxConcurrent:s.maxConcurrent,sortOrder:s.sortOrder,shortCode:s.shortCode})),
    sources:world.sources.map(s=>({shiftId:s.id,employeeId:s.employeeId,date:s.date,board:s.board,sourcePosition:s.sourcePosition,startAt:s.startAt.toISOString(),
      endAt:s.endAt.toISOString(),supersededAt:s.supersededAt?.toISOString()??null,boardRemoved:s.boardRemoved})),
    hours:world.hours.map(h=>({shiftId:h.shiftId,hourStart:new Date(h.hourStartMs).toISOString(),revision:h.revision,
      ...(h.revision===null?{legacySha256:h.legacySha256}:{}),intervals:h.segments.map(s=>({startAt:new Date(s.startMs).toISOString(),endAt:new Date(s.endMs).toISOString(),
        state:s.state,stationId:s.stationId,seatNumber:s.seatNumber,provenance:h.id?{kind:"v2",paintHourId:h.id,segmentId:s.id}:{kind:"legacy",assignmentId:s.assignmentId??null}}))})),
    coverDisplay:await quarterCoverDisplay(db,world,board,now)};
}
