import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Command, Defaults, Response, Review, Status, Batch } from "@/lib/receipts/protocol";
import type { HostCommand } from "@/lib/receipts/host";

type Step = { step_id: string; request?: unknown; boundary?: string; expect: { response?: unknown }; host_translation_example?: { request: HostCommand; response: unknown; public_response: unknown } };
export const fixtureBytes = readFileSync("fixtures/receipts/v4-examples.json");
export const fixtureHash = createHash("sha256").update(fixtureBytes).digest("hex");
export const fixtures = JSON.parse(fixtureBytes.toString()) as {
  cases: { case_id: string; scenarios: { name: string; steps: Step[] }[] }[];
  common_setup: { authenticated_manager: { actor_id: string }; registry: { device_id: string }[]; defaults: Defaults };
};
export const devices = fixtures.common_setup.registry.map((d) => d.device_id);
export const actor = fixtures.common_setup.authenticated_manager.actor_id;
export function example(caseId: string, scenario: string, stepIndex = 0) {
  const step = fixtures.cases.find((c) => c.case_id === caseId)!.scenarios.find((s) => s.name === scenario)!.steps[stepIndex];
  return structuredClone(step) as Step & { request: Command; expect: { response: Response } };
}
export const first = () => example("V4-01", "two-documents");
export const review = () => first().expect.response.data as Review;
export const batch = () => example("V4-01", "two-documents", 2).expect.response.data as Batch;
export const status = () => example("V4-09", "successive-requests").expect.response.data as Status;
export function response(command: Command, data: Response["data"], state: Response["state"] = "ok", reason: Response["reason"] = null): Response {
  return { schema: "receipt-public/v1", request_id: command.request_id, op: command.op, state, reason, data };
}
