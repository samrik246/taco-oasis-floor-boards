import { NextResponse } from "next/server";
import { requireManagerSession } from "@/lib/managers/require-session";
import { requireDayAccess } from "@/lib/managers/day-access";
import { quarterBody, quarterError } from "@/lib/quarter/http";
import { parsePaintCommand } from "@/lib/quarter/protocol";
import { paintV2 } from "@/lib/quarter/transaction";
export const runtime = "nodejs";
export async function PUT(request:Request) {
  const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;
  try {
    const command=parsePaintCommand(await quarterBody(request));
    const access=await requireDayAccess(request,command.date);if(!access.ok)return access.response;
    return NextResponse.json(await paintV2(command,auth.manager),{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
