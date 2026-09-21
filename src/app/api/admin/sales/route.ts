import { NextResponse } from "next/server";
import { z } from "zod";
import { rejectManagerSecrets } from "@/lib/admin/validate";
import { requireManagerSession } from "@/lib/managers/require-session";
import {
  isRushBoard,
  readHourlySalesPercents,
  saveHourlySalesPercents,
} from "@/lib/rush/sales-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const board = url.searchParams.get("board") ?? "";
  const dow = Number(url.searchParams.get("dow"));
  if (!isRushBoard(board) || !Number.isInteger(dow) || dow < 0 || dow > 6) {
    return NextResponse.json(
      { error: "board and dow (0–6) are required" },
      { status: 400 },
    );
  }
  const sales = await readHourlySalesPercents(board, dow);
  return NextResponse.json({
    ...sales,
    metric: "percent-of-day-sales",
  });
}

const putSchema = z.object({
  board: z.enum(["caja", "cocina"]),
  dow: z.number().int().min(0).max(6),
  percents: z.array(
    z.object({
      hour: z.number().int().min(7).max(21),
      percent: z.number().min(0).max(100),
    }),
  ),
});

export async function PUT(req: Request) {
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;
  try {
    const json = await req.json();
    const secret = rejectManagerSecrets(json);
    if (secret) return NextResponse.json({ error: secret }, { status: 422 });
    const body = putSchema.parse(json);
    const sales = await saveHourlySalesPercents(body);
    if (!sales.ok) {
      return NextResponse.json({ error: sales.error }, { status: 422 });
    }
    return NextResponse.json({ ...sales.sales, metric: "percent-of-day-sales" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid sales percents" }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Failed to save sales";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
