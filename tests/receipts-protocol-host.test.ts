import { describe, expect, it, vi } from "vitest";
import { parseCommand, parseJSON, parseResponse, parseResponseFor, refusal } from "@/lib/receipts/protocol";
import { handleReceipt, translateResult, type ReceiptDependencies, type DurableReceiptAdapter } from "@/lib/receipts/host";
import { actor, devices, example, first, fixtureHash, fixtures, review } from "./helpers/receipt-fixtures";
import { adopted } from "./helpers/receipt-projection-fixtures";

function request(value: unknown, headers: Record<string, string> = {}) {
  return new Request("http://local/api/receipts", { method: "POST", headers: { "content-type": "application/json", "x-manager-session": "synthetic", origin: "http://local", ...headers }, body: typeof value === "string" ? value : JSON.stringify(value) });
}
function dependencies() {
  const host = first().host_translation_example!;
  const engine = {
    lookupRequest: vi.fn<DurableReceiptAdapter["lookupRequest"]>(async () => ({ kind: "absent" })),
    contentHandles: vi.fn<DurableReceiptAdapter["contentHandles"]>(async () => ({ kind: "resolved", value: host.request.args.content_handles as string[] })),
    plan: vi.fn<DurableReceiptAdapter["plan"]>(async () => ({ kind: "resolved", value: { plan_id: "1".repeat(32), plan_sha256: "2".repeat(64) } })),
    execute: vi.fn<NonNullable<ReceiptDependencies["engine"]>["execute"]>(async () => JSON.stringify(host.response) + "\n"),
  };
  return { devices, authenticate: vi.fn(async () => actor as string | null), engine };
}

describe("frozen V4 examples are protocol fixtures, not engine transition execution", () => {
  it("retains the accepted bytes and all 16 cases / 43 scenarios / 70 steps", () => {
    expect(fixtureHash).toBe("ff38147c7ad065a5b231e41c280c74adb90cc772b84ed3ff9394d8eed7d703e3");
    expect(fixtures.cases).toHaveLength(16);
    expect(fixtures.cases.flatMap((c) => c.scenarios)).toHaveLength(43);
    expect(fixtures.cases.flatMap((c) => c.scenarios.flatMap((s) => s.steps))).toHaveLength(70);
  });
  for (const c of adopted.shared.cases) for (const s of c.scenarios) for (const step of s.steps) {
    if (!step.expect.response) continue; // Trusted content import is not a browser op.
    it(`${c.case_id} ${s.name}: ${step.step_id} conforms to the public boundary`, () => {
      const result = parseResponse(step.expect.response, devices);
      expect(result).toEqual(step.expect.response);
      if (result.reason === "invalid_request") expect(() => parseCommand(step.request, devices)).toThrow();
      else { const cmd = parseCommand(step.request, devices); expect(cmd).toEqual(step.request); expect(parseResponseFor(cmd, result, devices)).toEqual(result); }
    });
  }
});

describe("closed receipt boundary", () => {
  it("rejects duplicate/escaped duplicate keys, unknown fields, incorrect scalars and unsafe text", () => {
    for (const text of ['{"op":1,"op":2}', '{"op":1,"\\u006fp":2}', '{"x":{"id":1,"id":2}}', '[1e999]', '[] true']) expect(() => parseJSON(text, 8192)).toThrow();
    const input = first().request;
    for (const changed of [ { ...input, actor_id: actor }, { ...input, args: { ...input.args, path: "/private" } }, { ...input, args: { ...input.args, expected_defaults_revision: true } }, { ...input, args: { ...input.args, reason: "x\u001b" } }, { ...input, args: { ...input.args, reason: "e\u0301" } }, { ...input, args: { ...input.args, reason: "x".repeat(161) } } ]) expect(() => parseCommand(changed, devices)).toThrow();
    expect(() => parseJSON('"éé"', 5)).toThrow();
    expect(() => parseJSON("[".repeat(34) + "0" + "]".repeat(34), 8192)).toThrow();
  });
  it("rejects wrong totals, duplicate roles, nonpending CAMBIO without observation, and false aggregate success", () => {
    const a = first().expect.response;
    expect(() => parseResponse({ ...a, data: { ...review(), total_documents: 1 } }, devices)).toThrow();
    const dup = review(); dup.documents[1].role = dup.documents[0].role;
    expect(() => parseResponse({ ...a, data: dup }, devices)).toThrow();
    const partial = example("V4-14", "possible-paper").expect.response;
    if (!partial.data || !("original_state" in partial.data)) throw new Error("fixture");
    partial.data.original_state = "ok";
    expect(() => parseResponse(partial, devices)).toThrow();
    const invalid = example("V4-01", "two-documents", 2).expect.response;
    if (!invalid.data || !("documents" in invalid.data)) throw new Error("fixture");
    const doc = invalid.data.documents[0];
    if (!("allowed_actions" in doc)) throw new Error("fixture");
    doc.allowed_actions.push("cambio");
    expect(() => parseResponse(invalid, devices)).toThrow();
  });
  it("uses independent nullable structural correlation, with no invented request", () => {
    expect(refusal({ op: "invented", request_id: "bad" }, "invalid_request")).toMatchObject({ request_id: null, op: null });
    expect(() => parseResponse({ ...refusal(null, "invalid_request"), state: "ok" })).toThrow();
  });
});

describe("authenticated host with only injected fake engine", () => {
  it("substitutes owned handles, authenticates actor, strips private fields and returns the validated review without host persistence", async () => {
    const deps = dependencies(), fixture = first();
    const result = await handleReceipt(request(fixture.request), deps);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(fixture.expect.response);
    expect(deps.engine.execute).toHaveBeenCalledExactlyOnceWith(fixture.host_translation_example!.request, { authenticatedActor: actor, browserCommand: fixture.request });
    expect(deps.engine.contentHandles).toHaveBeenCalledWith(actor, (fixture.request as { args: { document_handles: string[] } }).args.document_handles);
  });
  it("substitutes only the bound private plan on submit and read_review", async () => {
    for (const op of ["submit", "read_review"] as const) {
      const deps = dependencies();
      const command = { schema: "receipt-browser/v1" as const, request_id: "3".repeat(32), op, args: { review_handle: "4".repeat(32) } };
      deps.engine.execute.mockImplementation(async () => JSON.stringify({ ...refusal(command, "stale_plan"), schema: "receipt-result/v1" }) + "\n");
      expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, "stale_plan"));
      expect(deps.engine.plan).toHaveBeenCalledExactlyOnceWith(actor, command.args.review_handle);
      expect(deps.engine.execute.mock.calls[0][0]).toMatchObject({ actor_id: actor, args: { plan_id: "1".repeat(32), plan_sha256: "2".repeat(64) } });
    }
  });
  it("refuses auth/CSRF/version/schema failures before any engine call", async () => {
    const cases: [Request, boolean][] = [
      [request(first().request, { origin: "https://elsewhere" }), true],
      [request(first().request, { "sec-fetch-site": "cross-site" }), true],
      [request(first().request, { "x-manager-session": "" }), true],
      [request(first().request), false],
      [request({ ...first().request, actor_id: actor }), true],
      [request({ ...first().request, schema: "receipt-browser/v9" }), true],
      [request('{"request_id":"a","request_id":"b"}'), true],
      [request('"' + "é".repeat(5000) + '"'), true],
    ];
    for (const [req, auth] of cases) {
      const deps = dependencies(); if (!auth) deps.authenticate.mockResolvedValue(null);
      const res = await handleReceipt(req, deps);
      expect(res.status).toBeGreaterThanOrEqual(400); expect((await res.json()).state).toBe("refused");
      expect(deps.engine.execute).not.toHaveBeenCalled();
      expect(deps.engine.lookupRequest).not.toHaveBeenCalled();
      expect(deps.engine.contentHandles).not.toHaveBeenCalled();
      expect(deps.engine.plan).not.toHaveBeenCalled();
    }
  });
  it("refuses malformed UTF8 and never passes raw child diagnostics to a browser", async () => {
    const deps = dependencies();
    const req = new Request("http://local/api/receipts", { method: "POST", headers: { "content-type": "application/json", "x-manager-session": "synthetic" }, body: new Uint8Array([0xc3, 0x28]) });
    expect((await handleReceipt(req, deps)).status).toBe(400); expect(deps.engine.execute).not.toHaveBeenCalled();
    const originals = JSON.stringify(first().host_translation_example!.response);
    for (const bad of [originals + "\n{}\n", originals.replace('"plan_id":', '"secret":"PRIVATE", "plan_id":') + "\n", originals.replace('"plan_id":', '"_plan":{}, "plan_id":') + "\n", originals.replace(first().request.request_id, "f".repeat(32)) + "\n", "x".repeat(65536) + "\n"]) {
      deps.engine.execute.mockResolvedValue(bad);
      const result = await handleReceipt(request(first().request), deps);
      expect(await result.json()).toEqual(refusal(first().request, "result_unconfirmed", "unavailable"));
    }
  });
  it("does not execute when a handle is not owned and never equates lost output with no send", async () => {
    const deps = dependencies(); deps.engine.contentHandles.mockRejectedValue(new Error("private path"));
    const res = await handleReceipt(request(first().request), deps);
    expect(await res.json()).toEqual(refusal(first().request, "result_unconfirmed", "unavailable"));
    expect(deps.engine.execute).not.toHaveBeenCalled();
    deps.engine.contentHandles.mockResolvedValue({ kind: "resolved", value: ["1".repeat(32), "2".repeat(32)] });
    deps.engine.execute.mockRejectedValue(new Error("lost"));
    expect((await (await handleReceipt(request(first().request), deps)).json()).reason).toBe("result_unconfirmed");
  });
  it("requires recovery of the original request and correlated device status", async () => {
    const cmd = example("V4-01", "two-documents", 3).request;
    const result = { ...example("V4-13", "unknown-history").expect.response, schema: "receipt-result/v1", request_id: cmd.request_id };
    expect(await translateResult(JSON.stringify(result) + "\n", cmd, devices)).toMatchObject({ state: "unavailable", reason: "unknown_request" });
    const mismatch = { ...result, state: "ok", reason: null, data: { original_request_id: "f".repeat(32), original_op: "read_defaults", original_state: "ok", original_reason: null, original_data: fixtures.common_setup.defaults } };
    await expect(translateResult(JSON.stringify(mismatch) + "\n", cmd, devices)).rejects.toThrow();
  });
  it("production dependency absence stays unavailable regardless of command and never creates history", async () => {
    const deps: ReceiptDependencies = { devices, authenticate: async () => actor };
    for (const cmd of [first().request, example("V4-01", "two-documents", 3).request, example("V4-05", "one-action-per-new-prepare").request]) {
      const res = await handleReceipt(request(cmd), deps);
      expect(res.status).toBe(503); expect(await res.json()).toEqual(refusal(cmd, cmd.op === "recover" ? "history_unavailable" : "runtime_unavailable", "unavailable"));
    }
  });
});

it("rejects correctly shaped responses for a different test device/count/mode or order selection", async () => {
  const one = example("V4-05", "one-action-per-new-prepare");
  const data = one.expect.response.data;
  if (!data || !("review_handle" in data)) throw new Error("fixture");
  const wrongDevice = structuredClone(data); wrongDevice.documents[0].device_id = devices[3]; wrongDevice.totals = [{ device_id: devices[3], count: 1 }];
  const wrongMode = { ...data, mode: "order" };
  for (const invalid of [wrongDevice, wrongMode, review()]) expect(() => parseResponseFor(one.request, { ...one.expect.response, data: invalid }, devices)).toThrow();
  const swapped = review(); swapped.documents.reverse(); swapped.totals.reverse();
  expect(() => parseResponseFor(first().request, { ...first().expect.response, data: swapped }, devices)).toThrow();
  const deps = dependencies();
  const malformed = structuredClone(first().host_translation_example!.response) as { data: { documents: unknown[]; totals: unknown[] } };
  malformed.data.documents.reverse(); malformed.data.totals.reverse();
  deps.engine.execute.mockResolvedValue(JSON.stringify(malformed) + "\n");
  const result = await handleReceipt(request(first().request), deps);
  expect((await result.json()).reason).toBe("result_unconfirmed");
});

describe("G2 exact child-result framing", () => {
  const json = JSON.stringify(first().host_translation_example!.response);
  const invalidFrames: [string, string][] = [
    ["empty output", ""],
    ["empty line", "\n"],
    ["missing terminal LF", json],
    ["two terminal LFs", json + "\n\n"],
    ["leading blank line", "\n" + json + "\n"],
    ["CRLF", json + "\r\n"],
    ["CR delimiter", json + "\r"],
    ["leading CR", "\r" + json + "\n"],
    ["interior newline", json.replace('{', '{\n') + "\n"],
    ["whitespace after delimiter", json + "\n "],
    ["second JSON line", json + "\n{}\n"],
    ["trailing JSON on the same line", json + "{}\n"],
    ["duplicate key with valid framing", json.replace('"schema":', '"schema":"receipt-result/v1","schema":') + "\n"],
  ];
  it.each(invalidFrames)("refuses %s without retrying or accepting malformed output", async (_name, raw) => {
    const deps = dependencies();
    await expect(translateResult(raw, first().request, devices)).rejects.toThrow();
    deps.engine.execute.mockResolvedValue(raw);
    const result = await handleReceipt(request(first().request), deps);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual(refusal(first().request, "result_unconfirmed", "unavailable"));
    expect(deps.engine.execute).toHaveBeenCalledTimes(1);
  });
  it("accepts one terminal LF and counts it in the inclusive 64 KiB limit", async () => {
    const bytes = new TextEncoder().encode(json).length;
    const atLimit = json + " ".repeat(65536 - bytes - 1) + "\n";
    expect(new TextEncoder().encode(atLimit)).toHaveLength(65536);
    for (const raw of [json + "\n", atLimit]) {
      expect(await translateResult(raw, first().request, devices)).toEqual(first().expect.response);
    }
    await expect(translateResult(" " + atLimit, first().request, devices)).rejects.toThrow("size");
  });
});


it("matches Origin to the actual destination Host, not Next's internal localhost URL", async () => {
  const deps = dependencies();
  const headers = { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" };
  expect((await handleReceipt(request(first().request, headers), deps)).status).toBe(200);
  for (const bad of ["http://localhost", "http://elsewhere", "null"]) {
    const result = await handleReceipt(request(first().request, { ...headers, origin: bad }), deps);
    expect(result.status).toBe(401);
  }
  expect((await handleReceipt(request(first().request, { ...headers, host: "127.0.0.1:3100/private" }), deps)).status).toBe(401);
  expect(deps.engine.execute).toHaveBeenCalledTimes(1);
});
