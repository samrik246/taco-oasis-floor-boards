import {NextResponse} from "next/server";
import {requireOwnerSession} from "@/lib/managers/require-session";
import {prisma} from "@/lib/db";
import {quarterError,boundedJsonBody} from "@/lib/quarter/http";
import {clientEvidence,clientRequestOrigin} from "@/lib/quarter/client-evidence";
export const runtime="nodejs";
export async function POST(request:Request){
  const auth=await requireOwnerSession(request);if(!auth.ok)return auth.response;
  try{
    const input=await boundedJsonBody(request,128*1024);
    const origin=clientRequestOrigin(request);
    return NextResponse.json(await clientEvidence(input,auth.manager.id,origin,prisma),{headers:{"Cache-Control":"no-store"}});
  }catch(e){return quarterError(e);}
}
