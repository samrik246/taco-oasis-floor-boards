// Browser-only synthetic fixture; no application route imports this bundle.
import { createRoot } from "react-dom/client";
import { ReceiptWorkspace } from "../../src/components/receipts/ReceiptWorkspace";
import fixture from "../../fixtures/receipts/unfinished-v2.json";
import closed from "../../fixtures/receipts/closed-batch-examples-v1.json";
import shared from "../../fixtures/receipts/v4-examples.json";
import { refusal, type Command, type Response, type Observed } from "../../src/lib/receipts/protocol";

const query = new URLSearchParams(location.search);
const locale = query.get("locale") === "en" ? "en" : "es";
const selected = fixture.positive_cases.find((c) => c.case_id === (query.get("case") ?? "U09"))!;
const steps = selected.steps.filter((s) => s.request.op === "recover");
const original = { request_id: (steps[0].request.args as { original_request_id: string }).original_request_id, op: "submit" };
const closedMode = query.get("closed") === "1";
const ids = closed.examples.identities;
const entries = [ids.submit_b1, ids.submit_b2].map((request_id) => ({ request_id, op: "submit" }));
sessionStorage.setItem("receipt-journal-v1:projection-manager", JSON.stringify(closedMode ? { pending: entries[1], entries } : { pending: original, entries: [original] }));
const calls: Command[] = [];
Object.assign(window, { receiptFakeCalls: calls, receiptProjectionOriginal: original });
let index = 0;
async function transport(command: Command): Promise<Response> {
  calls.push(command);
  if (closedMode) {
    if (command.op === "recover") {
      const example = command.args.original_request_id === ids.submit_b1 ? closed.examples.original_id_b1_recovery : closed.examples.original_id_b2_recovery;
      return { ...structuredClone(example.response) as Response, request_id: command.request_id };
    }
    if (command.op === "observe") return { schema: "receipt-public/v1", op: "observe", request_id: command.request_id, state: "ok", reason: null, data: { observation_id: "e".repeat(32), attempt: { ...closed.examples.direct_b2_replay.response.data.documents[0], observation: command.args.observation, observation_id: "e".repeat(32), reservation_revision: 8, last_event_at: "2000-01-01T00:00:07.000Z" } } as Observed };
    return refusal(command, "unsupported_action");
  }
  if (command.op !== "recover") return refusal(command, "unsupported_action");
  const step = steps[Math.min(index++, steps.length - 1)];
  return { ...structuredClone(step.expect.public_response) as Response, request_id: command.request_id };
}
createRoot(document.getElementById("root")!).render(<main className="min-h-dvh bg-neutral-50 p-5 text-xl text-neutral-950" style={{ colorScheme: "light" }}>
  <p className="mb-4 border-2 border-dashed p-3">{locale === "es" ? "EJEMPLO SINTÉTICO · SIN IMPRESORA" : "SYNTHETIC EXAMPLE · NO PRINTER"}</p>
  <ReceiptWorkspace manager={{ id: "projection-manager", token: "synthetic" }} devices={shared.common_setup.registry.map((d) => d.device_id)} locale={locale} onLock={() => {}} transport={transport} />
</main>);
