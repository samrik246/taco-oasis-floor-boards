import { NextResponse } from "next/server";
import { requireManagerSession } from "@/lib/managers/require-session";
import { requireDayAccess } from "@/lib/managers/day-access";
import { quarterBody,quarterError } from "@/lib/quarter/http";
import { removalCommandSchema,removeRestoreV2 } from "@/lib/quarter/removals";
export const runtime = "nodejs";
export async function POST(request:Request) {
  const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;
  try {
    const command=removalCommandSchema.parse(await quarterBody(request));
    const access=await requireDayAccess(request,command.date);if(!access.ok)return access.response;
    return NextResponse.json(await removeRestoreV2(command,auth.manager),{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
