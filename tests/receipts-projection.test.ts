import { expect, it } from "vitest";
import { parseResponseFor, type Review, type Command } from "@/lib/receipts/protocol";
import { translateResult } from "@/lib/receipts/host";
import { devices } from "./helpers/receipt-fixtures";
import closed from "../fixtures/receipts/closed-batch-examples-v1.json";
import { adopted, adoptOverlay, unfinished } from "./helpers/receipt-projection-fixtures";

it("adopts only the uniquely selected expectation while retaining both original pinned baselines", () => {
  const { request, positive, negative_control } = adopted.overlay.case;
  expect(parseResponseFor(request, positive.response, devices)).toEqual(positive.response);
  expect(() => parseResponseFor(request, negative_control.response, devices)).toThrow("actions");
  for (const entry of adopted.overlay.baselines) expect(entry.selector).toEqual({ case: "V4-14", scenario: "active-coordinator", step: "read-aggregate" });
  expect(() => adoptOverlay(Buffer.from("{}"))).toThrow("baseline pin");
});

for (const c of unfinished.positive_cases) for (const step of c.steps) it(`${c.case_id} ${step.step_id}: actual host/public projection preserves the complete validated response`, async () => {
  const before = JSON.stringify(step);
  expect(parseResponseFor(step.request, step.expect.public_response, devices)).toEqual(step.expect.public_response);
  expect(await translateResult(JSON.stringify(step.input_host_response) + "\n", step.request, devices)).toEqual(step.expect.public_response);
  expect(JSON.stringify(step)).toBe(before);
});

const trustedOnly = new Set(["trusted_projection", "trusted_owner_projection", "trusted_history"]);
for (const c of unfinished.negative_cases) for (const step of c.steps) {
  if (trustedOnly.has(step.expect.rejection_layer ?? "")) continue; // Requires authoritative engine state; not a parser claim.
  it(`${c.case_id}: ${step.expect.rejection_layer} rejects hostile projection`, async () => {
    expect(() => parseResponseFor(step.request, step.input_public_response, devices)).toThrow();
    if (step.expect.rejection_layer !== "public_projection") await expect(translateResult(JSON.stringify(step.input_host_response) + "\n", step.request, devices)).rejects.toThrow();
    else {
      // N29's host bytes are valid; only its leaked public expectation is hostile.
      const projected = await translateResult(JSON.stringify(step.input_host_response) + "\n", step.request, devices);
      for (const field of ["artifact_sha256", "logical_key", "profile_sha256"]) expect(JSON.stringify(projected)).not.toContain(field);
    }
  });
}

it("keeps eight engine-authority negatives explicitly outside stateless validation acceptance", () => {
  expect(unfinished.negative_cases.filter((c) => c.steps.some((s) => trustedOnly.has(s.expect.rejection_layer ?? ""))).map((c) => c.case_id)).toEqual(["N15", "N16", "N17", "N18", "N19", "N23", "N24", "N25"]);
});

it.each(["x", "é"])("counts the complete public recovery wrapper at the 65536-byte boundary (%s)", (char) => {
  const step = unfinished.positive_cases.find((c) => c.case_id === "U15")!.steps[1];
  const response = structuredClone(step.expect.public_response!);
  if (!response.data || !("original_data" in response.data)) throw new Error("fixture recovery");
  const review = response.data.original_data as Review;
  const lines = review.documents[0].preview_lines;
  const size = () => new TextEncoder().encode(JSON.stringify(response) + "\n").length;
  // Leave room for a final line, keeping every line within the public limit.
  lines.push(char);
  while (65536 - size() > 518) lines.push("x".repeat(512));
  lines.push("");
  const missing = 65536 - size();
  lines[lines.length - 1] = char.repeat(Math.floor(missing / new TextEncoder().encode(char).length)) + (char === "é" && missing % 2 ? "x" : "");
  expect(size()).toBe(65536);
  expect(parseResponseFor(step.request, response, devices)).toEqual(response);
  lines[lines.length - 1] += "x";
  expect(size()).toBe(65537);
  expect(() => parseResponseFor(step.request, response, devices)).toThrow("result size");
});

for (const name of ["direct_b1_replay", "original_id_b1_recovery", "direct_b2_replay", "original_id_b2_recovery"] as const) it(name + ": pinned closed-batch example passes the actual validator unchanged", () => {
  const example = closed.examples[name];
  expect(parseResponseFor(example.request as Command, example.response, devices)).toEqual(example.response);
});
it("direct and recovered closed sends agree without confusing their shared attempt and current revision", () => {
  const e = closed.examples;
  for (const [direct, recovered] of [[e.direct_b1_replay.response, e.original_id_b1_recovery.response], [e.direct_b2_replay.response, e.original_id_b2_recovery.response]] as const) {
    expect(recovered.data.original_state).toBe(direct.state);
    expect(recovered.data.original_reason).toBe(direct.reason);
    expect(recovered.data.original_data).toEqual(direct.data);
  }
  expect(e.direct_b1_replay.response.data.documents[0].attempt_id).toBe(e.direct_b2_replay.response.data.documents[0].attempt_id);
  expect(e.direct_b1_replay.response.data.documents[0].reservation_revision).toBe(e.direct_b2_replay.response.data.documents[0].reservation_revision);
  expect(e.direct_b1_replay.response.data.plan_handle).not.toBe(e.direct_b2_replay.response.data.plan_handle);
});
