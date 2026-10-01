import { NextResponse } from "next/server";
import { requireManagerSession } from "@/lib/managers/require-session";
import { requireDayAccess } from "@/lib/managers/day-access";
import { quarterBody,quarterError } from "@/lib/quarter/http";
import { operationSchema,operateV2 } from "@/lib/quarter/operations";
export const runtime = "nodejs";
export async function POST(request:Request) {
  const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;
  try {
    const command=operationSchema.parse(await quarterBody(request));
    for(const date of command.operation==="copy"?[command.date,command.sourceDate]:[command.date]){
      const access=await requireDayAccess(request,date);if(!access.ok)return access.response;
    }
    return NextResponse.json(await operateV2(command,auth.manager),{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
