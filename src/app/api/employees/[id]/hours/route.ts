import { NextResponse } from "next/server";
import { z } from "zod";
import { getEmployeeWeekHours } from "@/lib/ledger";
import { requireManagerSession } from "@/lib/managers/require-session";
import { NO_STORE } from "@/lib/managers/day-access";

export const runtime = "nodejs";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const querySchema = z.object({
  weekOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/employees/:id/hours?weekOf=YYYY-MM-DD
 * Hours ledger (person × station minutes) for the Chicago week containing weekOf
 * (defaults to today in America/Chicago if omitted — callers should pass board date).
 * A week includes planned days, so this is manager-only (the panel is too).
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await requireManagerSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { id } = paramsSchema.parse(await context.params);
    const url = new URL(request.url);
    const { weekOf } = querySchema.parse({
      weekOf: url.searchParams.get("weekOf") ?? undefined,
    });

    const weekOfDate =
      weekOf ??
      new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    const ledger = await getEmployeeWeekHours(id, weekOfDate);
    if (!ledger) {
      return NextResponse.json({ error: "Employee not found" }, { status: 404 });
    }
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request", details: err.issues },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Bad request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
