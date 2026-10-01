import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireManagerSession } from "@/lib/managers/require-session";
import { requireDayAccess } from "@/lib/managers/day-access";
import { quarterError } from "@/lib/quarter/http";
import { quarterState,QuarterRefused } from "@/lib/quarter/schema";
export const runtime="nodejs";
const query=z.strictObject({date:z.iso.date(),board:z.enum(["caja","cocina"])});
export async function GET(request:Request){
  const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;
  try{
    const input=query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const access=await requireDayAccess(request,input.date);if(!access.ok)return access.response;
    const result=await prisma.$transaction(async db=>{
      const state=await quarterState(db);if(state?.phase!=="active")throw new QuarterRefused("QUARTER_NOT_ACTIVE");
      // Explicit manager projection: immutable source/legacy snapshots never leave the server.
      const rows=await db.$queryRawUnsafe<{id:string;actorId:string;requestId:string;shiftId:string;startMs:string;endMs:string;operation:string;reason:string|null;moveNote:string|null;createdAtMs:string}[]>(
        "SELECT id,actorId,requestId,shiftId,CAST(startMs AS TEXT) AS startMs,CAST(endMs AS TEXT) AS endMs,operation,reason,moveNote,CAST(createdAtMs AS TEXT) AS createdAtMs FROM PaintMutation WHERE date=? AND board=? ORDER BY createdAtMs DESC,id DESC",input.date,input.board);
      return {protocol:2,databaseEpoch:state.databaseEpoch,mutations:rows.map(({startMs,endMs,createdAtMs,...row})=>({...row,startAt:new Date(Number(startMs)).toISOString(),endAt:new Date(Number(endMs)).toISOString(),createdAt:new Date(Number(createdAtMs)).toISOString()}))};
    });
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
