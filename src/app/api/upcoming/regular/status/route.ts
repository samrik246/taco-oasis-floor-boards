import { NextResponse } from "next/server";
import { regularEnabled } from "@/lib/regular/source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether this host serves Regulares. Próximos hides its link when off. Reads no orders. */
export async function GET() {
  return NextResponse.json(
    { enabled: regularEnabled() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
