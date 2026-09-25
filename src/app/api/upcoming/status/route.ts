import { NextResponse } from "next/server";
import { nextEnabled } from "@/lib/upcoming/source";

export const runtime = "nodejs";

/** Whether this host serves SQUARE NEXT. The floor hides its link when off. */
export async function GET() {
  return NextResponse.json(
    { enabled: nextEnabled() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
