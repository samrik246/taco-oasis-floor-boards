import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireDayAccess } from "@/lib/managers/day-access";
import { readQuarterDay } from "@/lib/quarter/public";
import { quarterError } from "@/lib/quarter/http";
export const runtime = "nodejs";
export async function GET(request:Request,{params}:{params:Promise<{board:string;date:string}>}) {
  const {board,date}=await params;
  if (!["caja","cocina"].includes(board)||!/^\d{4}-\d{2}-\d{2}$/.test(date))return NextResponse.json({code:"INVALID_DAY"},{status:422});
  const access=await requireDayAccess(request,date);if(!access.ok)return access.response;
  try {return NextResponse.json(await prisma.$transaction(db=>readQuarterDay(db,board,date)),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return quarterError(error);}
}
