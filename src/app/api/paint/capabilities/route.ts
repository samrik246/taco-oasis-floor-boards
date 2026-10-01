import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { quarterState, CAPABILITY_SHA256, FOUNDATION_CAPABILITIES } from "@/lib/quarter/schema";
import { quarterError } from "@/lib/quarter/http";
export const runtime = "nodejs";
export async function GET() {
  try {
    const state=await quarterState(prisma);
    return NextResponse.json({...FOUNDATION_CAPABILITIES,schema:2,phase:state?.phase??"legacy",databaseEpoch:state?.databaseEpoch??null,
      capabilitySha256:CAPABILITY_SHA256,features:{quarterPaint:false,blockNotes:false},
      readPath:"/api/v2/boards/{board}/days/{date}",writePath:"/api/v2/assignments/paint"},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
