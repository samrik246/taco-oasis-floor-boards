import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireManagerSession } from "@/lib/managers/require-session";
import { requireDayAccess } from "@/lib/managers/day-access";
import { quarterError } from "@/lib/quarter/http";
import { quarterTaskSuggestions } from "@/lib/quarter/task-suggestions";
export const runtime="nodejs";
const query=z.strictObject({date:z.iso.date(),quarter:z.string(),granularity:z.enum(["hour","quarter"]),templateId:z.string().min(1),forceLemon:z.enum(["true","false"]).optional()});
export async function GET(request:Request){
  const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;
  try{
    const input=query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const access=await requireDayAccess(request,input.date);if(!access.ok)return access.response;
    return NextResponse.json(await prisma.$transaction(db=>quarterTaskSuggestions(db,{...input,forceLemon:input.forceLemon==="true"})),{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
