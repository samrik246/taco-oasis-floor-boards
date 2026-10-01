// Test bundle only. No route or environment flag exposes this fake in the app.
import { createRoot } from "react-dom/client";
import { ReceiptWorkspace } from "../../src/components/receipts/ReceiptWorkspace";
import fixture from "../../fixtures/receipts/v4-examples.json";
import type { Command, Response, Review, Batch, Status } from "../../src/lib/receipts/protocol";

const caseOne = fixture.cases[0].scenarios[0].steps;
const data = (i: number) => (caseOne[i].expect as { response: Response }).response.data;
const prepared = data(0) as Review;
const sent = data(2) as Batch;
const devices = fixture.common_setup.registry.map((d) => d.device_id);
const calls: Command[] = [];
const locale = new URLSearchParams(location.search).get("locale") === "en" ? "en" : "es";
Object.assign(window, { receiptFakeCalls: calls });
const now = "2026-10-01T04:00:00.000Z";
let refreshCount = 0;
async function transport(command: Command): Promise<Response> {
  calls.push(command);
  let result: Response["data"];
  if (command.op === "read_defaults" || command.op === "save_defaults") result = fixture.common_setup.defaults;
  else if (command.op === "submit") {
    const rows = structuredClone(sent);
    rows.documents[1].state = "uncertain"; rows.documents[1].reason = "result_unconfirmed";
    return { schema: "receipt-public/v1", request_id: command.request_id, op: command.op, state: "partial", reason: "result_unconfirmed", data: rows };
  } else if (command.op === "status_cached" || command.op === "status_refresh") {
    const phase = command.op === "status_cached" ? "fresh" : new URLSearchParams(location.search).get("phase") ?? ["failed", "busy", "throttled"][refreshCount++ % 3];
    result = { device_id: command.args.device_id, registry_revision: 4, profile_sha256: null, commissioned_for_orders: false,
      last_request_at: now, last_probe_at: now,
      last_outcome: phase === "fresh" || phase === "expired" ? "valid" : phase === "busy" ? "busy" : phase === "throttled" ? "throttled" : "failed",
      reason: phase === "failed" ? "no_response" : phase === "busy" ? "device_busy" : phase === "throttled" ? "rate_limited" : null,
      last_valid: { observed_at: now, expires_at: "2026-10-01T04:01:00.000Z", condition: "blocked", identity_match: true, problems: ["paper_out", "cover_open"], warnings: ["paper_near_end"] },
      condition: phase === "fresh" ? "blocked" : phase === "expired" ? "stale" : phase === "busy" ? "busy" : phase === "throttled" ? "rate_limited" : "unknown",
      display_code: phase === "fresh" ? "paper_out" : phase === "expired" ? "stale" : phase === "busy" ? "busy" : phase === "throttled" ? "rate_limited" : "no_response" } satisfies Status;
  } else result = { ...structuredClone(prepared), created_at: now, expires_at: "2026-10-01T04:05:00.000Z" };
  return { schema: "receipt-public/v1", request_id: command.request_id, op: command.op, state: "ok", reason: null, data: result };
}
createRoot(document.getElementById("root")!).render(<main className="min-h-dvh bg-neutral-50 p-5 text-xl text-neutral-950" style={{ colorScheme: "light" }}><p className="mb-4 border-2 border-dashed p-3">{locale === "es" ? "EJEMPLO SINTÉTICO · SIN IMPRESORA" : "SYNTHETIC EXAMPLE · NO PRINTER"}</p><ReceiptWorkspace manager={{ id: "fixture-manager", token: "synthetic" }} documents={prepared.documents} devices={devices} locale={locale} onLock={() => {}} transport={transport} /></main>);
