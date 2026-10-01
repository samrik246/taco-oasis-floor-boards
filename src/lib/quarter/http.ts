import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "@/lib/db";
import { QuarterRefused, requireLegacy } from "./schema";
import { QUARTER_MEDIA_TYPE } from "./protocol";

export function quarterError(error:unknown) {
  if (error instanceof QuarterRefused) return NextResponse.json({ok:false,code:error.code,draftRetained:true,...error.details},{status:error.status,headers:{"Cache-Control":"no-store"}});
  if (error instanceof ZodError) return NextResponse.json({ok:false,code:"INVALID_V2_COMMAND",draftRetained:true},{status:422});
  throw error;
}
export async function legacyHttpGuard() {
  try {await requireLegacy(prisma);return null;} catch(error) {return quarterError(error);}
}
export async function quarterBody(request:Request) {
  if (request.headers.get("x-floor-boards-protocol")!=="2" || request.headers.get("content-type")?.split(";")[0].trim()!==QUARTER_MEDIA_TYPE)
    throw new QuarterRefused("UNSUPPORTED_PROTOCOL",415);
  return boundedJsonBody(request,2*1024*1024);
}
export async function boundedJsonBody(request:Request,limit:number){
  const reader=request.body?.getReader();
  if (!reader) throw new QuarterRefused("INVALID_V2_COMMAND",422);
  const chunks:Uint8Array[]=[];let size=0;
  for (;;) {
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>limit){await reader.cancel();throw new QuarterRefused("REQUEST_TOO_LARGE",413);}
    chunks.push(value);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new QuarterRefused("INVALID_V2_COMMAND",422);}
}
