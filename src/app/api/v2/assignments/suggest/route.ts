import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireManagerSession } from "@/lib/managers/require-session";
import { requireDayAccess } from "@/lib/managers/day-access";
import { quarterError } from "@/lib/quarter/http";
import { quarterFavorites } from "@/lib/quarter/suggestions";
export const runtime="nodejs";
const query=z.strictObject({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),board:z.enum(["caja","cocina"]),quarter:z.string(),granularity:z.enum(["hour","quarter"])});
export async function GET(request:Request) {
  const auth=await requireManagerSession(request);if(!auth.ok)return auth.response;
  try {
    const input=query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const access=await requireDayAccess(request,input.date);if(!access.ok)return access.response;
    return NextResponse.json(await prisma.$transaction(db=>quarterFavorites(db,input)),{headers:{"Cache-Control":"no-store"}});
  }catch(error){return quarterError(error);}
}
