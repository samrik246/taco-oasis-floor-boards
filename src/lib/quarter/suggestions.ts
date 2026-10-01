import type { QuarterDb } from "./schema";
import { QuarterRefused,CAPABILITY_SHA256 } from "./schema";
import { assignedIntervals,resolvePaintWorld,overlaps } from "./world";
import { projectSeatNumbers } from "./validation";
import { quarterInstant } from "./protocol";

/** Suggestions retain the exact snapshot; a later paint command must revalidate it. */
export async function quarterFavorites(db:QuarterDb,input:{date:string;board:"caja"|"cocina";quarter:string;granularity:"quarter"|"hour"}) {
  const startMs=quarterInstant(input.date,input.quarter),endMs=startMs+(input.granularity==="hour"?3600000:900000);
  if(input.granularity==="hour"&&!input.quarter.endsWith(":00"))throw new QuarterRefused("INVALID_HOUR",422);
  const world=await resolvePaintWorld(db,input.date);
  if(world.state?.phase!=="active")throw new QuarterRefused("QUARTER_NOT_ACTIVE");
  projectSeatNumbers(world);
  const intervals=assignedIntervals(world).filter(s=>overlaps(s,{startMs,endMs}));
  const bookings=await db.staffBreak.findMany({where:{date:input.date,status:"booked",startAt:{lt:new Date(endMs)},endAt:{gt:new Date(startMs)}},
    select:{employeeId:true,coverEmployeeId:true,shuffleEmployeeId:true}});
  const overlays=await db.boardOverlay.findMany({where:{date:input.date,cancelledAt:null,startAt:{lt:new Date(endMs)},endAt:{gt:new Date(startMs)}},select:{employeeId:true,partnerEmployeeId:true}});
  const busy=new Set([...intervals.map(s=>s.employeeId),...bookings.flatMap(b=>[b.employeeId,b.coverEmployeeId,b.shuffleEmployeeId]),...overlays.flatMap(o=>[o.employeeId,o.partnerEmployeeId])]);
  const sources=world.sources.filter(s=>s.board===input.board&&!s.supersededAt&&!s.boardRemoved&&+s.startAt<endMs&&+s.endAt>startMs&&!busy.has(s.employeeId));
  const abilities=await db.employeeStationAbility.findMany({where:{employeeId:{in:sources.map(s=>s.employeeId)},level:"preferred"}});
  const names=await db.employee.findMany({where:{id:{in:sources.map(s=>s.employeeId)}},select:{id:true,firstName:true,lastName:true}});
  const candidates=world.stations.filter(s=>s.board===input.board).map(station=>{
    if(intervals.some(i=>i.stationId===station.id))return {stationId:station.id,candidate:null};
    const eligible=sources.filter(s=>abilities.some(a=>a.employeeId===s.employeeId&&a.stationId===station.id)&&
      !world.sources.some(other=>other.id!==s.id&&other.employeeId===s.employeeId&&!other.supersededAt&&!other.boardRemoved&&+other.startAt<endMs&&+other.endAt>startMs));
    eligible.sort((a,b)=>+a.startAt-+b.startAt||a.id.localeCompare(b.id));
    const best=eligible[0],person=best?names.find(n=>n.id===best.employeeId):null;
    return {stationId:station.id,candidate:best&&person?{shiftId:best.id,employeeId:person.id,firstName:person.firstName,lastName:person.lastName,
      startAt:new Date(Math.max(startMs,+best.startAt)).toISOString(),endAt:new Date(Math.min(endMs,+best.endAt)).toISOString()}:null};
  });
  return {protocol:2,capabilitySha256:CAPABILITY_SHA256,expected:{databaseEpoch:world.state.databaseEpoch,worldRevision:world.revision!},
    startAt:new Date(startMs).toISOString(),endAt:new Date(endMs).toISOString(),candidates};
}
