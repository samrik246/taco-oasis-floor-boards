import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireManagerSession, requestIsOwner } from "@/lib/managers/require-session";
import { requireDayAccess, boardDateSchema, NO_STORE } from "@/lib/managers/day-access";
import { MANDATORY_STATIONS_BY_BOARD, isDefaultMandatory } from "@/lib/mandatory";
import { loadColumnDefaults } from "@/lib/abilities/column-settings";
import { quarterState, worldRevision } from "@/lib/quarter/schema";
import { quarterError } from "@/lib/quarter/http";
import { chicagoToday } from "@/lib/upcoming/source";
export const runtime="nodejs";
/** Separate authorization boundary; this response is never a public-cache input. */
export async function GET(request:Request,{params}:{params:Promise<{board:string;date:string}>}){
  const {board,date}=await params;
  if((board!=="caja"&&board!=="cocina")||!boardDateSchema.safeParse(date).success)return NextResponse.json({code:"INVALID_DAY"},{status:422});
  const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;
  const access=await requireDayAccess(request,date);if(!access.ok)return access.response;
  const owner=await requestIsOwner(request);
  try{return NextResponse.json(await prisma.$transaction(async db=>{
    const state=await quarterState(db);
    const marks=await db.mandatoryMark.findMany({where:{board,date},select:{stationId:true},orderBy:{stationId:"asc"}});
    const extraStationIds=marks.map(m=>m.stationId).filter(id=>!isDefaultMandatory(id));
    const abilities:Record<string,{stationId:string;level:string}[]>={};
    if(owner){
      const defaults=await loadColumnDefaults(db),employees=await db.employee.findMany({where:{shifts:{some:{date,board,boardRemoved:false}}},select:{id:true,abilities:{select:{stationId:true,level:true}}}});
      for(const e of employees)abilities[e.id]=[...e.abilities,...[...defaults].filter(([id,level])=>level==="forbidden"&&!e.abilities.some(a=>a.stationId===id)).map(([stationId])=>({stationId,level:"forbidden"}))];
    }
    return {databaseEpoch:state?.databaseEpoch??null,worldRevision:state?await worldRevision(db):null,
      mandatory:{stationIds:[...MANDATORY_STATIONS_BY_BOARD[board],...extraStationIds],extraStationIds,canMark:owner},overlayMenu:date===chicagoToday(),...(owner?{abilities}:{})};
  }),{headers:NO_STORE});}catch(error){return quarterError(error);}
}
