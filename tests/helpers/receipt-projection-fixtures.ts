import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Command, Response } from "@/lib/receipts/protocol";

type Step = { step_id: string; request: Command; input_host_response: unknown; input_public_response?: unknown; expect: { validation: string; public_response?: Response; rejection_layer?: string } };
type Case = { case_id: string; label: string; steps: Step[] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const unfinishedBytes = readFileSync("fixtures/receipts/unfinished-v2.json");
if (hash(unfinishedBytes) !== "e02e6f8bf27fbde7b22c58472e2c639c5421d1c01ba7664e0e6c184e1968bbd6") throw new Error("unfinished fixture pin");
export const unfinished = JSON.parse(unfinishedBytes.toString()) as { positive_cases: Case[]; negative_cases: Case[] };

const sharedBytes = readFileSync("fixtures/receipts/v4-examples.json");
const wireBytes = readFileSync("fixtures/receipts/wire-baseline.json");
const overlayBytes = readFileSync("fixtures/receipts/unfinished-overlay-v1.json");
type Shared = { cases: { case_id: string; scenarios: { name: string; steps: { step_id: string; request: unknown; expect: { response?: unknown } }[] }[] }[] };
type Wire = { vectors: { case: string; scenario: string; step: string; request: unknown; response: unknown }[] };
type Overlay = { baselines: { name: string; sha256: string; selector: { case: string; scenario: string; step: string }; response_pointer: string; patch: { op: string; path: string; value: unknown }[] }[]; case: { request: Command; positive: { response: Response }; negative_control: { response: Response } } };
function at(value: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce((v, key) => (v as Record<string, unknown>)[key], value);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Test expectations only. Never imported by application code or response paths. */
export function adoptOverlay(sharedRaw = sharedBytes, wireRaw = wireBytes, overlayRaw = overlayBytes) {
  if (hash(overlayRaw) !== "d4abc41f9f99323b33f9f2d411bd5c3c4e327ded3d97a7e492b65df537f9f8e4") throw new Error("overlay pin");
  const overlay = JSON.parse(overlayRaw.toString()) as Overlay;
  const output: unknown[] = [];
  for (const [index, bytes] of [sharedRaw, wireRaw].entries()) {
    const entry = overlay.baselines[index];
    if (hash(bytes) !== entry.sha256) throw new Error("baseline pin");
    const parsed = JSON.parse(bytes.toString()) as Shared | Wire;
    const selected = "cases" in parsed
      ? parsed.cases.filter((c) => c.case_id === entry.selector.case).flatMap((c) => c.scenarios.filter((s) => s.name === entry.selector.scenario).flatMap((s) => s.steps.filter((step) => step.step_id === entry.selector.step).map((step) => ({ request: step.request, response: step.expect.response }))))
      : parsed.vectors.filter((v) => v.case === entry.selector.case && v.scenario === entry.selector.scenario && v.step === entry.selector.step);
    if (selected.length !== 1 || !same(selected[0].request, overlay.case.request) || selected[0].response !== at(parsed, entry.response_pointer) || !same(selected[0].response, overlay.case.negative_control.response)) throw new Error("selector");
    const copy = structuredClone(parsed);
    for (const patch of entry.patch) {
      if (patch.op === "test") { if (!same(at(copy, patch.path), patch.value)) throw new Error("patch precondition"); }
      else if (patch.op === "replace") {
        const parts = patch.path.split("/"); const key = parts.pop()!;
        (at(copy, parts.join("/")) as Record<string, unknown>)[key] = structuredClone(patch.value);
      } else throw new Error("patch operation");
    }
    if (!same(at(copy, entry.response_pointer), overlay.case.positive.response)) throw new Error("overlay result");
    output.push(copy);
  }
  return { shared: output[0] as Shared, wire: output[1] as Wire, overlay };
}
export const adopted = adoptOverlay();
