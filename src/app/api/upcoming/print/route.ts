import { NextResponse } from "next/server";
import { z } from "zod";
import { staffSessionFromRequest } from "@/lib/breaks/session";
import { requireManagerSession } from "@/lib/managers/require-session";
import { managerSessionFromRequest, readManagerSession } from "@/lib/managers/session";
import { getUpcomingSource } from "@/lib/upcoming/source";
import {
  PrintModelError,
  TAIL_RE,
  loadPrintModel,
  printConfigFromEnv,
  readLedger,
  runPrint,
} from "@/lib/print/t4g-print";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

async function tailIsUpcoming(tail: string): Promise<boolean> {
  const snapshot = await getUpcomingSource().load(new Date());
  return snapshot.orders.some((o) => o.id_tail === tail);
}

/** A staff kiosk token, in either header, with no manager token beside it. */
function staffOnly(req: Request): boolean {
  if (managerSessionFromRequest(req)) return false;
  const managerHeader = req.headers.get("x-manager-session");
  if (managerHeader && !readManagerSession(managerHeader) && managerHeader.startsWith("staff:")) return true;
  return staffSessionFromRequest(req) != null;
}

/**
 * GET ?tail=X: whether printing is on here, and the ledger state for the
 * button label. Sends nothing to a printer.
 */
export async function GET(req: Request) {
  const cfg = printConfigFromEnv();
  if (!cfg) return json({ printing: false });
  const tail = new URL(req.url).searchParams.get("tail") ?? "";
  if (!TAIL_RE.test(tail)) return json({ error: "bad tail" }, 400);
  if (!(await tailIsUpcoming(tail))) return json({ error: "unknown order" }, 404);
  const ledger = await readLedger(tail, cfg);
  if (ledger === null) return json({ printing: true, history_available: false, error: "history_unavailable" }, 503);
  return json({
    printing: true,
    printed: ledger.printed,
    locked_until: ledger.locked_until,
  });
}

const bodySchema = z.object({ tail: z.string().regex(TAIL_RE) });

/** The Imprimir tap. Manager only. Returns status, never the model. */
export async function POST(req: Request) {
  const cfg = printConfigFromEnv();
  if (!cfg) return json({ error: "printing is off" }, 404);
  if (staffOnly(req)) return json({ error: "Manager code required" }, 403);
  const auth = await requireManagerSession(req);
  if (!auth.ok) return auth.response;

  let tail: string;
  try {
    tail = bodySchema.parse(await req.json()).tail;
  } catch {
    return json({ error: "bad tail" }, 400);
  }
  if (!(await tailIsUpcoming(tail))) return json({ error: "unknown order" }, 404);

  let model: Record<string, unknown>;
  try {
    model = await loadPrintModel(tail, cfg);
  } catch (err) {
    if (err instanceof PrintModelError) {
      return json({ status: "refused", id_tail: tail, cambio: false, problems: ["no_model"], locked_until: null }, 502);
    }
    throw err;
  }

  const result = await runPrint(model, tail, cfg);
  console.info(`T4G PRINT order=${tail} status=${result.status} by=${auth.manager.id}`);
  return json(result);
}
