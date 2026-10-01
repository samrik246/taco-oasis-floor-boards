import { describe, expect, it, vi } from "vitest";
import { handleReceipt, type DurableReceiptAdapter, type ExecutionContext, type Lookup, type Resolution, type Plan } from "@/lib/receipts/host";
import { OPS, parseCommand, refusal, type Command, type Op } from "@/lib/receipts/protocol";
import { actor, devices, first, fixtures } from "./helpers/receipt-fixtures";

const mutations: Op[] = ["prepare", "prepare_test", "re_review", "submit", "observe", "save_defaults"];
function commandFor(op: Op): Command {
  for (const c of fixtures.cases) for (const s of c.scenarios) for (const step of s.steps) {
    try { const command = parseCommand(step.request, devices); if (command.op === op) return command; } catch { /* A fixture may intentionally be invalid. */ }
  }
  throw new Error(`no valid ${op} fixture`);
}
const request = (command: Command) => new Request("http://local/api/receipts", {
  method: "POST", headers: { "content-type": "application/json", "x-manager-session": "synthetic", origin: "http://local" }, body: JSON.stringify(command),
});
function resultLine(command: Command, reason: "request_conflict" | "history_unavailable" | "stale_plan" = "stale_plan", state: "refused" | "unavailable" = "refused") {
  return JSON.stringify({ ...refusal(command, reason, state), schema: "receipt-result/v1" }) + "\n";
}
function dependencies() {
  const privateReview = first().host_translation_example!;
  const engine = {
    lookupRequest: vi.fn<DurableReceiptAdapter["lookupRequest"]>(async () => ({ kind: "absent" })),
    contentHandles: vi.fn<DurableReceiptAdapter["contentHandles"]>(async () => ({ kind: "resolved", value: privateReview.request.args.content_handles as string[] })),
    plan: vi.fn<DurableReceiptAdapter["plan"]>(async () => ({ kind: "resolved", value: { plan_id: "1".repeat(32), plan_sha256: "2".repeat(64) } })),
    execute: vi.fn<DurableReceiptAdapter["execute"]>(async (_command, context) => resultLine(context.browserCommand)),
  };
  return { devices, authenticate: vi.fn(async () => actor), engine };
}
function noTranslationOrExecution(engine: ReturnType<typeof dependencies>["engine"]) {
  expect(engine.contentHandles).not.toHaveBeenCalled();
  expect(engine.plan).not.toHaveBeenCalled();
  expect(engine.execute).not.toHaveBeenCalled();
}

describe("V2 host dispatch with fake durable adapters, not engine atomicity proof", () => {
  it.each(mutations)("looks up %s before any translation and passes the same context to execute", async (op) => {
    const command = commandFor(op), deps = dependencies();
    deps.engine.lookupRequest.mockImplementation(async (context) => {
      expect(context).toEqual({ authenticatedActor: actor, browserCommand: command });
      noTranslationOrExecution(deps.engine);
      return { kind: "absent" };
    });
    const res = await handleReceipt(request(command), deps);
    expect(await res.json()).toEqual(refusal(command, "stale_plan"));
    expect(deps.engine.lookupRequest).toHaveBeenCalledTimes(1);
    expect(deps.engine.execute).toHaveBeenCalledTimes(1);
    expect(deps.engine.execute.mock.calls[0][1]).toBe(deps.engine.lookupRequest.mock.calls[0][0]);
    expect(deps.engine.execute.mock.calls[0][0]).toMatchObject({ actor_id: actor, op, request_id: command.request_id });
  });

  it.each(OPS.filter((op) => !mutations.includes(op)))("keeps %s on its existing read/diagnostic path", async (op) => {
    const command = commandFor(op), deps = dependencies();
    deps.engine.lookupRequest.mockRejectedValue(new Error("must not create a browser association"));
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, "stale_plan"));
    expect(deps.engine.lookupRequest).not.toHaveBeenCalled();
    expect(deps.engine.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ op }), { authenticatedActor: actor, browserCommand: command });
  });

  it("freezes all accepted fields before the first engine await, retaining order and explicit nulls", async () => {
    const command = first().request, original = structuredClone(command), deps = dependencies();
    let captured: ExecutionContext | undefined;
    deps.engine.lookupRequest.mockImplementation(async (context) => {
      captured = context;
      expect(context.browserCommand).toEqual(original);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.browserCommand)).toBe(true);
      expect(Object.isFrozen(context.browserCommand.args)).toBe(true);
      if (context.browserCommand.op !== "prepare") throw new Error("fixture");
      const args = context.browserCommand.args;
      for (const value of [args.document_handles, args.device_ids, args.parent_attempt_ids, args.observation_ids]) expect(Object.isFrozen(value)).toBe(true);
      expect(() => { context.authenticatedActor = "f".repeat(32); }).toThrow();
      expect(() => args.document_handles.reverse()).toThrow();
      expect(() => { args.parent_attempt_ids[0] = "f".repeat(32); }).toThrow();
      await Promise.resolve();
      command.request_id = "e".repeat(32);
      return { kind: "absent" };
    });
    const response = await handleReceipt(request(command), deps);
    expect(await response.json()).toEqual(refusal(original, "stale_plan"));
    expect(deps.engine.execute.mock.calls[0][1]).toBe(captured);
    expect(captured?.browserCommand).toEqual(original);
    expect(deps.engine.contentHandles).toHaveBeenCalledWith(actor, (original as Extract<Command, { op: "prepare" }>).args.document_handles);
  });

  it("returns a retained prepare after a lost response without consulting changed source or a host review cache", async () => {
    const command = first().request, deps = dependencies();
    const retained = JSON.stringify(first().host_translation_example!.response) + "\n";
    deps.engine.execute.mockResolvedValue("lost response");
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, "result_unconfirmed", "unavailable"));
    // A fresh injected adapter represents the restarted host; retained history
    // is supplied by the engine contract, not a B4 ledger created in this test.
    const restarted = dependencies();
    restarted.engine.lookupRequest.mockResolvedValue({ kind: "bound", result: retained });
    restarted.engine.contentHandles.mockRejectedValue(new Error("source changed"));
    const cache = vi.fn(async () => { throw new Error("cache unavailable"); });
    Object.assign(restarted.engine, { rememberReview: cache });
    expect(await (await handleReceipt(request(command), restarted)).json()).toEqual(first().expect.response);
    noTranslationOrExecution(restarted.engine);
    expect(cache).not.toHaveBeenCalled();
    expect(deps.engine.execute).toHaveBeenCalledTimes(1);
  });

  it("returns retained submit refusal before expired review resolution", async () => {
    const command = commandFor("submit"), deps = dependencies();
    deps.engine.lookupRequest.mockResolvedValue({ kind: "bound", result: resultLine(command) });
    deps.engine.plan.mockRejectedValue(new Error("expired and no local mapping"));
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, "stale_plan"));
    noTranslationOrExecution(deps.engine);
  });

  it.each(["conflict", "unavailable"] as const)("returns validated %s lookup without translation", async (kind) => {
    const command = first().request, deps = dependencies();
    const reason = kind === "conflict" ? "request_conflict" : "history_unavailable";
    const state = kind === "conflict" ? "refused" : "unavailable";
    deps.engine.lookupRequest.mockResolvedValue({ kind, result: resultLine(command, reason, state) });
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, reason, state));
    noTranslationOrExecution(deps.engine);
  });

  const command = first().request;
  it.each([
    null, {}, { kind: "unknown" }, { kind: "absent", result: resultLine(command) },
    { kind: "bound", result: resultLine(command).trimEnd() },
    { kind: "bound", result: resultLine({ ...command, request_id: "f".repeat(32) }) },
    { kind: "bound", result: resultLine({ ...command, op: "read_defaults", args: {} }) },
    { kind: "conflict", result: resultLine(command, "history_unavailable", "unavailable") },
    { kind: "conflict", result: JSON.stringify(first().host_translation_example!.response) + "\n" },
    { kind: "unavailable", result: resultLine(command, "request_conflict") },
    { kind: "unavailable", result: resultLine(command, "history_unavailable", "refused") },
  ])("never treats malformed/inconsistent lookup %# as absence", async (lookup) => {
    const deps = dependencies();
    deps.engine.lookupRequest.mockResolvedValue(lookup as Lookup);
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, "result_unconfirmed", "unavailable"));
    noTranslationOrExecution(deps.engine);
  });

  it.each(["prepare", "read_review", "status_refresh"] as const)("rejects an older adapter without lookup support on %s", async (op) => {
    const command = commandFor(op), deps = dependencies();
    Reflect.deleteProperty(deps.engine, "lookupRequest");
    const reason = op === "status_refresh" ? "query_unavailable" : "result_unconfirmed";
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, reason, "unavailable"));
    noTranslationOrExecution(deps.engine);
  });

  it("passes the immutable original context when execute reports a concurrent winner after absent lookup", async () => {
    const deps = dependencies(), command = first().request;
    deps.engine.contentHandles.mockResolvedValue({ kind: "resolved", value: ["a".repeat(32), "b".repeat(32)] });
    deps.engine.execute.mockImplementation(async (privateCommand, context) => {
      expect(privateCommand.args).toMatchObject({ content_handles: ["a".repeat(32), "b".repeat(32)] });
      expect(context).toEqual({ authenticatedActor: actor, browserCommand: command });
      // Only the real engine can prove atomic winner selection; this checks
      // that the host preserves its input and accepts the correlated winner.
      return JSON.stringify(first().host_translation_example!.response) + "\n";
    });
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(first().expect.response);
    expect(deps.engine.execute).toHaveBeenCalledTimes(1);
  });
});

describe("typed pre-dispatch resolution versus unknown outcome", () => {
  for (const op of ["prepare", "submit", "read_review"] as const) {
    const command = commandFor(op);
    const resolve = (deps: ReturnType<typeof dependencies>, value: unknown) => {
      if (op === "prepare") deps.engine.contentHandles.mockResolvedValue(value as Resolution<string[]>);
      else deps.engine.plan.mockResolvedValue(value as Resolution<Plan>);
    };
    it.each([
      { kind: "unavailable", reason: "history_unavailable" },
      { kind: "unavailable", reason: "source_unavailable" },
      { kind: "refused", reason: "unauthorized" },
    ] as const)(`${op}: preserves known $kind/$reason without dispatch`, async (failure) => {
      const deps = dependencies(); resolve(deps, failure);
      const response = await handleReceipt(request(command), deps);
      expect(await response.json()).toEqual(refusal(command, failure.reason, failure.kind));
      expect(response.status).toBe(failure.kind === "unavailable" ? 503 : 403);
      expect(deps.engine.execute).not.toHaveBeenCalled();
    });
    it.each([null, [], { kind: "absent" }, { kind: "unavailable", reason: "unauthorized" }, { kind: "refused", reason: "source_unavailable" }, { kind: "unavailable", reason: "history_unavailable", value: "private" }, { kind: "resolved", value: {} }])(`${op}: rejects malformed resolution %# as unknown`, async (failure) => {
      const deps = dependencies(); resolve(deps, failure);
      expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, "result_unconfirmed", "unavailable"));
      expect(deps.engine.execute).not.toHaveBeenCalled();
    });
    it(`${op}: does not infer a known failure from exception text`, async () => {
      const deps = dependencies();
      const helper = op === "prepare" ? deps.engine.contentHandles : deps.engine.plan;
      helper.mockRejectedValue(new Error("history_unavailable source_unavailable PRIVATE"));
      const response = await handleReceipt(request(command), deps);
      expect(await response.json()).toEqual(refusal(command, "result_unconfirmed", "unavailable"));
      expect(deps.engine.execute).not.toHaveBeenCalled();
    });
  }
  it.each([[], ["a".repeat(32)], ["a".repeat(32), "a".repeat(32)], ["a".repeat(32), "bad"]].map((value) => ({ value })))("rejects wrong content binding %# without execute", async ({ value }) => {
    const deps = dependencies(), command = first().request;
    deps.engine.contentHandles.mockResolvedValue({ kind: "resolved", value });
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, "result_unconfirmed", "unavailable"));
    expect(deps.engine.execute).not.toHaveBeenCalled();
  });
  it("keeps a thrown lookup failure unknown and never falls through to execute", async () => {
    const deps = dependencies(), command = first().request;
    deps.engine.lookupRequest.mockRejectedValue(new Error("history_unavailable"));
    expect(await (await handleReceipt(request(command), deps)).json()).toEqual(refusal(command, "result_unconfirmed", "unavailable"));
    noTranslationOrExecution(deps.engine);
  });
});
