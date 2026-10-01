import type { SlicePaint } from "@/lib/slices/day-slices";
import { quarterState, type QuarterDb } from "./schema";
import { assignedIntervals, resolvePaintWorld } from "./world";

/** Legacy mode keeps its accepted hourly contract; active mode always supplies exact bounds. */
export async function decisionPaints(db:QuarterDb,date:string):Promise<SlicePaint[]> {
  if((await quarterState(db))?.phase==="active") {
    return assignedIntervals(await resolvePaintWorld(db,date)).map(s=>({employeeId:s.employeeId,shiftId:s.shiftId,
      stationId:s.stationId!,hourStart:new Date(s.startMs),intervalEnd:new Date(s.endMs)}));
  }
  const rows=await db.assignment.findMany({where:{shift:{date,supersededAt:null,boardRemoved:false}},
    select:{employeeId:true,shiftId:true,stationId:true,hourStart:true}});
  return rows.flatMap(r=>r.employeeId?[{...r,employeeId:r.employeeId}]:[]);
}
