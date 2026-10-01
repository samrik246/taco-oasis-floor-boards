import { NextResponse } from "next/server";
import { requireManagerSession } from "@/lib/managers/require-session";
import { requireDayAccess,optionalManager } from "@/lib/managers/day-access";
import { quarterBody,quarterError } from "@/lib/quarter/http";
import { tareaCommandSchema,tareaV2 } from "@/lib/quarter/tareas";
export const runtime="nodejs";
export async function POST(request:Request){
  try{
    const command=tareaCommandSchema.parse(await quarterBody(request));
    const access=await requireDayAccess(request,command.date);if(!access.ok)return access.response;
    let actor=await optionalManager(request);
    if(command.operation==="assign"){
      const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;actor=auth.manager;
    }
    return NextResponse.json(await tareaV2(command,actor??{id:"system:staff-status",name:"Staff"}),{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
