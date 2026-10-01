import {NextResponse} from "next/server";
import {requireOwnerSession} from "@/lib/managers/require-session";
import {prisma} from "@/lib/db";
import {quarterError} from "@/lib/quarter/http";
import {clientEvidence} from "@/lib/quarter/client-evidence";
export const runtime="nodejs";
export async function POST(request:Request){
  const auth=await requireOwnerSession(request);if(!auth.ok)return auth.response;
  try{
    const bytes=await request.text();if(Buffer.byteLength(bytes)>128*1024)return NextResponse.json({code:"REQUEST_TOO_LARGE"},{status:413});
    return NextResponse.json(await clientEvidence(JSON.parse(bytes),auth.manager.id,new URL(request.url).origin,prisma),{headers:{"Cache-Control":"no-store"}});
  }catch(e){return quarterError(e);}
}
