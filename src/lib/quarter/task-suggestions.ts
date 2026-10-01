import { positionFitFromSource,suggestAssignees,type SuggestionCandidate } from "@/lib/suggestions";
import type { AbilityLevel } from "@/lib/rules/types";
import { assignedIntervals,resolvePaintWorld,overlaps } from "./world";
import { CAPABILITY_SHA256,QuarterRefused,type QuarterDb } from "./schema";
import { quarterInstant } from "./protocol";

/** Exact-interval suggestions carry the snapshot that an assignment must recheck. */
export async function quarterTaskSuggestions(db:QuarterDb,input:{date:string;quarter:string;granularity:"hour"|"quarter";templateId:string;forceLemon?:boolean}) {
  const startMs=quarterInstant(input.date,input.quarter),endMs=startMs+(input.granularity==="hour"?3600000:900000);
  if(input.granularity==="hour"&&!input.quarter.endsWith(":00"))throw new QuarterRefused("INVALID_HOUR",422);
  const world=await resolvePaintWorld(db,input.date);
  if(world.state?.phase!=="active")throw new QuarterRefused("QUARTER_NOT_ACTIVE");
  const template=await db.tareaTemplate.findUnique({where:{id:input.templateId}});
  if(!template)throw new QuarterRefused("TAREA_NOT_FOUND",404);
  const sources=world.sources.filter(s=>s.board===template.board&&!s.supersededAt&&!s.boardRemoved&&+s.startAt<endMs&&+s.endAt>startMs);
  const ids=[...new Set(sources.map(s=>s.employeeId))];
  const people=await db.employee.findMany({where:{id:{in:ids}},select:{id:true,firstName:true,lastName:true,abilities:{select:{stationId:true,level:true}}}});
  const tasks=await db.tareaAssignment.groupBy({by:["employeeId"],where:{date:input.date,status:"working",unassignedAt:null,template:{board:template.board}},_count:{_all:true}});
  const breaks=await db.staffBreak.findMany({where:{date:input.date,status:"booked",startAt:{lt:new Date(endMs)},endAt:{gt:new Date(startMs)}},select:{employeeId:true,coverEmployeeId:true,shuffleEmployeeId:true}});
  const overlays=await db.boardOverlay.findMany({where:{date:input.date,cancelledAt:null,startAt:{lt:new Date(endMs)},endAt:{gt:new Date(startMs)}},select:{employeeId:true,partnerEmployeeId:true}});
  const blocked=new Set([...breaks.flatMap(b=>[b.employeeId,b.coverEmployeeId,b.shuffleEmployeeId]),...overlays.flatMap(o=>[o.employeeId,o.partnerEmployeeId])]);
  const paint=assignedIntervals(world);
  const candidates:SuggestionCandidate[]=people.flatMap(person=>{
    if(blocked.has(person.id))return [];
    const held=sources.filter(s=>s.employeeId===person.id);if(held.length!==1)return [];
    const segments=paint.filter(s=>s.employeeId===person.id&&overlaps(s,{startMs,endMs}));
    const seats=new Set(segments.map(s=>s.stationId));if(seats.size>1)return [];
    const seatId=segments[0]?.stationId??null;
    const ability=person.abilities.find(a=>a.stationId===(seatId??(template.board==="cocina"?"pdf_tq1r":"green1")))?.level??null;
    return [{employeeId:person.id,displayName:`${person.firstName} ${person.lastName}`.trim(),seatId,abilityLevel:ability as AbilityLevel|null,
      positionFit:positionFitFromSource(held[0].sourcePosition),activeTareaCount:tasks.find(t=>t.employeeId===person.id)?._count._all??0}];
  });
  return {protocol:2,capabilitySha256:CAPABILITY_SHA256,expected:{databaseEpoch:world.state.databaseEpoch,worldRevision:world.revision!},
    startAt:new Date(startMs).toISOString(),endAt:new Date(endMs).toISOString(),suggestions:suggestAssignees({templateId:input.templateId,candidates,forceLemonOnGreens:input.forceLemon})};
}
