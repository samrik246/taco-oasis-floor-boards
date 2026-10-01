import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryUnavailable, UnknownCompletion } from "@/lib/receipts/transport-supervisor";
import { canonical, line, LIMITS, type Correlation } from "@/lib/receipts/transport-codec";
import { residentAdapter } from "@/lib/receipts/resident-adapter";
import { handleReceipt, type HostCommand } from "@/lib/receipts/host";
import { type Command } from "@/lib/receipts/protocol";
import { actor, devices, first, fixtures } from "./helpers/receipt-fixtures";
import { reply, workerHarness } from "./helpers/receipt-transport";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T06:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const lookup = () => ({ method: "lookup_request" as const, authenticated_actor: actor, args: { browser_command: first().request } });
const request = (command: Command, authenticated = true) => new Request("http://localhost/api/receipts", { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { "x-manager-session": "synthetic" } : {}) }, body: JSON.stringify(command) });

it("never starts a worker from a call; lifecycle spawn has fixed argv, six env keys and verified READY", async () => {
  const h = workerHarness();
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).not.toHaveBeenCalled();
  await h.supervisor.start();
  expect(h.supervisor.status()).toMatchObject({ adapter_worker: "ok", pid: 1234, owned_worker: 1 });
  expect(h.launch.argv.slice(0, 4)).toEqual(["-S", "-B", "-m", "packing_ticket.receipt_adapter_worker"]);
  expect(Object.keys(h.launch.env).sort()).toEqual(["LANG", "PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "PYTHONPATH", "PYTHONPYCACHEPREFIX"]);
  expect(h.launch.env.PYTHONPYCACHEPREFIX).toBe("/var/empty");
  await h.supervisor.stop();
  expect(h.supervisor.status().owned_worker).toBe(0);
});

it.each(["interpreter", "importClosure", "protectedAncestorsAndACLs", "environmentAndCache", "acceptedConstructor"] as const)("H failure %s prevents spawn", async (field) => {
  const h = workerHarness(); const original = h.dependencies.verifyRuntime;
  h.dependencies.verifyRuntime = vi.fn(async () => { const value = await original(); (value.checks as Record<string, boolean>)[field] = false; return value; });
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).not.toHaveBeenCalled();
});
it("unknown prior ownership or failed lifecycle persistence blocks startup", async () => {
  const h = workerHarness(); h.dependencies.provePriorAbsence = vi.fn(async () => false);
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.supervisor.status().owned_worker).toBe("unknown"); expect(h.dependencies.spawn).not.toHaveBeenCalled();
  const failed = workerHarness(); failed.dependencies.writeLifecycle = vi.fn(async () => { throw new Error("unavailable"); });
  await expect(failed.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(failed.dependencies.spawn).not.toHaveBeenCalled();
});
it("a healthy reader is not gated on later device/H failures and replay spawns no child", async () => {
  const h = workerHarness(); await h.supervisor.start();
  h.dependencies.verifyRuntime = vi.fn(async () => { throw new Error("device/runtime pins changed"); });
  await expect(h.supervisor.call(lookup())).resolves.toMatchObject({ header: { kind: "absent" } });
  expect(h.dependencies.verifyRuntime).not.toHaveBeenCalled(); expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
  await h.supervisor.stop();
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
});
it("startup deadline includes missing READY and preserves no automatic restart", async () => {
  const h = workerHarness(); h.state.ready = false;
  const started = h.supervisor.start().catch((e) => e);
  await vi.advanceTimersByTimeAsync(10001);
  expect(await started).toBeInstanceOf(HistoryUnavailable);
  expect(h.child.signalOwnedGroup).toHaveBeenCalledWith("TERM");
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
});
it("wrong startup identity, unsolicited bytes and stderr overflow poison a generation", async () => {
  const wrong = workerHarness();
  const write = wrong.child.write;
  wrong.child.write = vi.fn(async (bytes) => {
    const v = JSON.parse(Buffer.from(bytes).toString());
    if (v.schema === "receipt-adapter-start/v1") wrong.emit(line({ schema: "receipt-adapter-ready/v1", generation: v.generation, pid: 999, engine_sha: "b".repeat(40), application_inventory_sha256: "c".repeat(64), config_sha256: v.config_sha256, capability: "association-only/v1" }, LIMITS.header));
    else await write(bytes);
  });
  await expect(wrong.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  for (const fault of ["idle", "stderr"] as const) {
    const h = workerHarness(); await h.supervisor.start();
    if (fault === "idle") h.emit(Buffer.from("\n")); else { h.stderr(Buffer.alloc(8192)); expect(h.supervisor.status().adapter_worker).toBe("ok"); h.stderr(Buffer.alloc(1)); }
    await h.supervisor.stop(); expect(h.supervisor.status().adapter_worker).toBe("unavailable");
  }
});
it("does not signal a worker whose returned group provenance is invalid", async () => {
  const h = workerHarness(); Object.defineProperty(h.child, "pgid", { value: 999 });
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.child.signalOwnedGroup).not.toHaveBeenCalled(); expect(h.supervisor.status().owned_worker).toBe("unknown");
});

it("serializes calls, snapshots their input and samples the clock at dispatch", async () => {
  const h = workerHarness(); await h.supervisor.start(); h.state.response = () => Buffer.alloc(0);
  const firstCall = h.supervisor.call(lookup());
  const nextInput = lookup(); const original = canonical(nextInput.args.browser_command);
  const second = h.supervisor.call(nextInput); nextInput.args.browser_command.args = {} as never;
  expect(h.inputs).toHaveLength(2); // startup + active
  await vi.advanceTimersByTimeAsync(1000);
  h.emit(reply(h.inputs[1] as unknown as Correlation)); await firstCall;
  await vi.advanceTimersByTimeAsync(0);
  expect(h.inputs).toHaveLength(3);
  const args = h.inputs[2].args as { now: string; browser_command: unknown };
  expect(args.now).toBe("2026-10-01T06:00:01.000Z"); expect(canonical(args.browser_command)).toBe(original);
  h.emit(reply(h.inputs[2] as unknown as Correlation)); await second; await h.supervisor.stop();
});
it("caps queued calls at 32 and expires unsent calls at two seconds", async () => {
  const h = workerHarness(); await h.supervisor.start(); h.state.response = () => Buffer.alloc(0);
  const active = h.supervisor.call(lookup()).catch((e) => e);
  const queued = Array.from({ length: 32 }, () => h.supervisor.call(lookup()).catch((e) => e));
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  await vi.advanceTimersByTimeAsync(2000);
  expect((await Promise.all(queued)).every((e) => e instanceof HistoryUnavailable)).toBe(true);
  expect(h.inputs).toHaveLength(2);
  await h.supervisor.stop(); expect(await active).toBeInstanceOf(UnknownCompletion);
});
it("call deadline includes blocked stdin even if a valid response was emitted", async () => {
  const h = workerHarness(); await h.supervisor.start(); const write = h.child.write;
  h.child.write = vi.fn(async (bytes) => { await write(bytes); await new Promise<void>(() => {}); });
  const outcome = h.supervisor.call(lookup()).catch((e) => e);
  await vi.advanceTimersByTimeAsync(10001);
  expect(await outcome).toBeInstanceOf(UnknownCompletion); expect(h.child.signalOwnedGroup).toHaveBeenCalledTimes(1);
});
it("TERM then KILL each get two seconds; unresolved reap blocks replacement", async () => {
  const h = workerHarness(); await h.supervisor.start();
  h.child.proveClosed = vi.fn(async () => ({ exited: true, reaped: true, groupAbsent: false }));
  const stop = h.supervisor.stop(); await vi.advanceTimersByTimeAsync(1999);
  expect(h.child.signalOwnedGroup.mock.calls).toEqual([["TERM"]]);
  await vi.advanceTimersByTimeAsync(1); expect(h.child.signalOwnedGroup.mock.calls).toEqual([["TERM"], ["KILL"]]);
  await vi.advanceTimersByTimeAsync(2000); await stop;
  expect(h.supervisor.status().owned_worker).toBe("unknown");
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
  await h.supervisor.stop();
  expect(h.child.signalOwnedGroup.mock.calls).toEqual([["TERM"], ["KILL"]]);
  expect(h.supervisor.status()).toMatchObject({ adapter_worker: "unresolved", owned_worker: "unknown" });
});
it("unknown completion closes the generation, while a known constructor failure keeps it usable", async () => {
  for (const status of ["history_unavailable", "unknown"] as const) {
    const h = workerHarness(); await h.supervisor.start();
    h.state.response = (c) => reply(c as unknown as Correlation, Buffer.alloc(0), { status, kind: null });
    if (status === "unknown") await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(UnknownCompletion);
    else await expect(h.supervisor.call(lookup())).resolves.toMatchObject({ header: { status } });
    expect(h.supervisor.status().adapter_worker).toBe(status === "unknown" ? "unavailable" : "ok");
    await h.supervisor.stop();
  }
});
it("extra output poisons a nominal frame and a late frame cannot satisfy a later call", async () => {
  const h = workerHarness(); await h.supervisor.start();
  h.state.response = (c) => Buffer.concat([reply(c as unknown as Correlation), Buffer.from("\n")]);
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(UnknownCompletion);
  const late = workerHarness(); await late.supervisor.start(); await late.supervisor.call(lookup());
  late.emit(reply(late.inputs[1] as unknown as Correlation)); await late.supervisor.stop();
  await expect(late.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
});

it("facade and actual handler retain auth, fixed diagnostic off and original-ID uncertainty", async () => {
  const h = workerHarness(); const engine = residentAdapter(h.supervisor, devices);
  const command: Command = { schema: "receipt-browser/v1", request_id: "a".repeat(32), op: "status_refresh", args: { device_id: devices[0] } };
  const deps = { devices, engine, authenticate: async () => actor };
  expect((await handleReceipt(request(command, false), deps)).status).toBe(401);
  expect(await (await handleReceipt(request(command), deps)).json()).toMatchObject({ request_id: command.request_id, state: "refused", reason: "gate_off" });
  expect(h.dependencies.spawn).not.toHaveBeenCalled();
  await h.supervisor.start();
  h.state.response = (c) => reply(c as unknown as Correlation, Buffer.alloc(0), { status: "unknown", kind: null });
  const original = first().request;
  expect(await (await handleReceipt(request(original), deps)).json()).toMatchObject({ request_id: original.request_id, state: "unavailable", reason: "result_unconfirmed" });
  expect(h.inputs).toHaveLength(2); expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
});
it("facade distinguishes known history failure for lookup, helpers and execute without retry", async () => {
  const h = workerHarness(); const engine = residentAdapter(h.supervisor, devices); const browser = first().request;
  expect(await engine.lookupRequest({ authenticatedActor: actor, browserCommand: browser })).toMatchObject({ kind: "unavailable" });
  expect(await engine.contentHandles(actor, ["a".repeat(32)])).toEqual({ kind: "unavailable", reason: "history_unavailable" });
  expect(await engine.plan(actor, "a".repeat(32))).toEqual({ kind: "unavailable", reason: "history_unavailable" });
  const read: Command = { schema: "receipt-browser/v1", request_id: "b".repeat(32), op: "read_defaults", args: {} };
  const raw = await engine.execute({ ...read, schema: "receipt-command/v1", actor_id: actor }, { authenticatedActor: actor, browserCommand: read });
  expect(JSON.parse(raw)).toMatchObject({ request_id: read.request_id, state: "unavailable", reason: "history_unavailable" });
  expect(h.dependencies.spawn).not.toHaveBeenCalled();
});
it("facade projects valid bound results and helpers; malformed resolutions poison the channel", async () => {
  const h = workerHarness(); await h.supervisor.start(); const engine = residentAdapter(h.supervisor, devices);
  const example = first(); const result = example.host_translation_example!.response;
  h.state.response = (c) => reply(c as unknown as Correlation, line(result, LIMITS.result), { kind: "bound" });
  expect((await engine.lookupRequest({ authenticatedActor: actor, browserCommand: example.request })).kind).toBe("bound");
  h.state.response = (c) => reply(c as unknown as Correlation, line({ kind: "resolved", value: ["a".repeat(32)] }, LIMITS.resolution));
  expect(await engine.contentHandles(actor, ["b".repeat(32)])).toEqual({ kind: "resolved", value: ["a".repeat(32)] });
  h.state.response = (c) => reply(c as unknown as Correlation, line({ kind: "resolved", value: ["bad"] }, LIMITS.resolution));
  await expect(engine.contentHandles(actor, ["b".repeat(32)])).rejects.toBeInstanceOf(UnknownCompletion);
  expect(h.supervisor.status().adapter_worker).toBe("unavailable");
});
it("valid execute read uses one exact host/browser context and no diagnostic fallback", async () => {
  const h = workerHarness(); await h.supervisor.start(); const engine = residentAdapter(h.supervisor, devices);
  const browser: Command = { schema: "receipt-browser/v1", request_id: "a".repeat(32), op: "read_defaults", args: {} };
  h.state.response = (c) => reply(c as unknown as Correlation, line({ schema: "receipt-result/v1", request_id: browser.request_id, op: browser.op, state: "ok", reason: null, data: fixtures.common_setup.defaults }, LIMITS.result));
  const host: HostCommand = { ...browser, schema: "receipt-command/v1", actor_id: actor };
  expect(JSON.parse(await engine.execute(host, { authenticatedActor: actor, browserCommand: browser })).data).toEqual(fixtures.common_setup.defaults);
  expect(h.inputs[1].args).toMatchObject({ browser_command: browser, host_command: host });
  await h.supervisor.stop();
});
it.each(["readLifecycle", "provePriorAbsence"] as const)("bounds stalled startup evidence %s without spawning", async (method) => {
  const h = workerHarness();
  h.dependencies[method] = vi.fn(() => new Promise<never>(() => {}));
  const start = h.supervisor.start().catch((e) => e);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await start).toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).not.toHaveBeenCalled();
});
it("latches a stalled journal and never trusts its later completion", async () => {
  const h = workerHarness(); let finish!: () => void;
  h.dependencies.writeLifecycle = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const start = h.supervisor.start().catch((e) => e);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await start).toBeInstanceOf(HistoryUnavailable);
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(h.supervisor.status().owned_worker).toBe("unknown");
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).not.toHaveBeenCalled();
});
it("a delayed ready journal cannot open dispatch, even after its timeout settles", async () => {
  const h = workerHarness(); let finish!: () => void;
  h.dependencies.writeLifecycle = vi.fn(async (record) => {
    if (record.adapter_worker === "ok") await new Promise<void>((resolve) => { finish = resolve; });
  });
  const start = h.supervisor.start().catch((e) => e);
  await vi.advanceTimersByTimeAsync(0);
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await start).toBeInstanceOf(HistoryUnavailable);
  finish(); await vi.advanceTimersByTimeAsync(0);
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.child.signalOwnedGroup.mock.calls).toEqual([["TERM"]]);
});
it("cleanup bookkeeping has a bound and failed persistence inhibits replacement", async () => {
  const h = workerHarness(); await h.supervisor.start();
  h.dependencies.writeLifecycle = vi.fn(() => new Promise<void>(() => {}));
  const stop = h.supervisor.stop(); await vi.advanceTimersByTimeAsync(2000); await stop;
  expect(h.supervisor.status()).toMatchObject({ adapter_worker: "unresolved", owned_worker: "unknown" });
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
});
it("does not dispatch queued work before full semantic result validation", async () => {
  const h = workerHarness(); await h.supervisor.start(); h.state.response = () => Buffer.alloc(0);
  const input = { method: "plan" as const, authenticated_actor: actor, args: { review_handle: "a".repeat(32) } };
  const active = h.supervisor.call(input).catch((e) => e);
  const queued = h.supervisor.call(input).catch((e) => e);
  h.emit(reply(h.inputs[1] as unknown as Correlation, line({ kind: "resolved", value: { plan_id: "bad", plan_sha256: "f".repeat(64) } }, LIMITS.resolution)));
  expect(await active).toBeInstanceOf(UnknownCompletion);
  expect(await queued).toBeInstanceOf(HistoryUnavailable);
  expect(h.inputs).toHaveLength(2);
  expect(h.supervisor.status().adapter_worker).toBe("unavailable");
});
