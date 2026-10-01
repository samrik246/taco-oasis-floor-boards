import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireManagerSession } from "@/lib/managers/require-session";
import { requireDayAccess } from "@/lib/managers/day-access";
import { receiptFor } from "@/lib/quarter/transaction";
import { quarterError } from "@/lib/quarter/http";
export const runtime = "nodejs";
export async function GET(request:Request,{params}:{params:Promise<{requestId:string}>}) {
  const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;
  const {requestId}=await params;
  try {
    const row=await receiptFor(prisma,auth.manager.id,requestId);
    if (!row)return NextResponse.json({code:"SAVE_UNCONFIRMED"},{status:404});
    const mutations=await prisma.$queryRawUnsafe<{date:string}[]>("SELECT DISTINCT date FROM PaintMutation WHERE actorId=? AND requestId=?",auth.manager.id,requestId);
    const response=JSON.parse(row.responseJson);
    const dates=new Set<string>([...mutations.map(m=>m.date),...(Array.isArray(response.dates)?response.dates:[])]);
    if(!dates.size)return NextResponse.json({code:"SAVE_RECEIPT_SCOPE_UNAVAILABLE"},{status:409});
    for(const date of dates){const access=await requireDayAccess(request,date);if(!access.ok)return access.response;}
    return NextResponse.json(response,{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
