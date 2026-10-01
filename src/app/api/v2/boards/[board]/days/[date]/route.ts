import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireDayAccess,boardDateSchema } from "@/lib/managers/day-access";
import { readQuarterDay } from "@/lib/quarter/public";
import { quarterError } from "@/lib/quarter/http";
export const runtime = "nodejs";
export async function GET(request:Request,{params}:{params:Promise<{board:string;date:string}>}) {
  const {board,date}=await params;
  if (!["caja","cocina"].includes(board)||!boardDateSchema.safeParse(date).success)return NextResponse.json({code:"INVALID_DAY"},{status:422});
  const access=await requireDayAccess(request,date);if(!access.ok)return access.response;
  try {return NextResponse.json(await prisma.$transaction(db=>readQuarterDay(db,board,date)),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return quarterError(error);}
}
