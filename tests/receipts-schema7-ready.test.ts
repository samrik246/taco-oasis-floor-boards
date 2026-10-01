import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { digest, LIMITS, line, ReadyCollector } from "@/lib/receipts/transport-codec";
import { HistoryUnavailable, type LifecycleRecord, type SupervisorDependencies } from "@/lib/receipts/transport-supervisor";
import { actor, first } from "./helpers/receipt-fixtures";
import { configValue, workerHarness } from "./helpers/receipt-transport";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T06:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const ready = (generation = "a".repeat(64)) => ({
  schema: "receipt-adapter-ready/v1", generation, pid: 1234,
  engine_sha: "b".repeat(40), application_inventory_sha256: "c".repeat(64),
  config_sha256: digest(line(configValue(), LIMITS.config)), capability: "schema7-association-only/v1",
});
const lookup = () => ({ method: "lookup_request" as const, authenticated_actor: actor, args: { browser_command: first().request } });
const records = (h: ReturnType<typeof workerHarness>) => vi.mocked(h.dependencies.writeLifecycle).mock.calls.map(([record]) => record);

it("collects exactly the schema7 capability across byte boundaries", () => {
  const value = ready(), bytes = line(value, LIMITS.header), collector = new ReadyCollector();
  for (const byte of bytes.subarray(0, -1)) expect(collector.push(Uint8Array.of(byte))).toBeNull();
  expect(collector.push(bytes.subarray(-1))).toEqual(value);
});

it.each(["association-only/v1", "schema5-association-only/v1", "schema7-association-only/v2", "schema7-coordinator/v1", "", null, ["schema7-association-only/v1"]])("refuses wrong or old READY capability %j", (capability) => {
  expect(() => new ReadyCollector().push(line({ ...ready(), capability }, LIMITS.header))).toThrow();
});

it("retains the observed READY identities in frozen bounded internal evidence through stop", async () => {
  const h = workerHarness();
  expect(h.supervisor.status().last_ready).toBeNull();
  await h.supervisor.start();
  const expected = ready(h.launch.generation);
  expect(h.supervisor.status().last_ready).toEqual(expected);
  const writes = records(h);
  expect(writes.slice(0, -1).every((record) => record.last_ready === null)).toBe(true);
  expect(writes.at(-1)).toMatchObject({ adapter_worker: "ok", generation: expected.generation, pid: expected.pid, last_ready: expected });
  expect(Object.isFrozen(writes.at(-1))).toBe(true);
  expect(Object.isFrozen(h.supervisor.status().last_ready)).toBe(true);
  expect(Reflect.set(h.supervisor.status().last_ready!, "capability", "association-only/v1")).toBe(false);
  expect(writes.every((record) => Buffer.byteLength(JSON.stringify(record), "utf8") < LIMITS.header)).toBe(true);
  await h.supervisor.stop();
  expect(h.supervisor.status()).toEqual({ adapter_worker: "unavailable", generation: null, pid: null, owned_worker: 0, last_ready: expected });
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
});

it.each(["old", "wrong", "pid", "generation", "engine", "inventory", "config", "missing", "extra"])("failed startup %s never records an accepted observation or dispatches a call", async (fault) => {
  const h = workerHarness();
  h.child.write = vi.fn(async () => {
    const value: Record<string, unknown> = ready(h.launch.generation);
    if (fault === "old") value.capability = "association-only/v1";
    if (fault === "wrong") value.capability = "schema7-coordinator/v1";
    if (fault === "pid") value.pid = 2345;
    if (fault === "generation") value.generation = "f".repeat(64);
    if (fault === "engine") value.engine_sha = "f".repeat(40);
    if (fault === "inventory") value.application_inventory_sha256 = "f".repeat(64);
    if (fault === "config") value.config_sha256 = "f".repeat(64);
    if (fault === "missing") delete value.capability;
    if (fault === "extra") value.coordinator = true;
    h.emit(line(value, LIMITS.header));
  });
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(records(h).every((record) => record.last_ready === null && record.adapter_worker !== "ok")).toBe(true);
  expect(h.supervisor.status().last_ready).toBeNull();
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.child.write).toHaveBeenCalledTimes(1);
  expect(h.child.signalOwnedGroup.mock.calls).toEqual([["TERM"]]);
  expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
});

it.each(["runtime", "spawn", "timeout", "throw", "reject", "reply-then-throw", "reply-then-reject"])("startup %s failure cannot invent READY from config or incomplete success", async (fault) => {
  const h = workerHarness();
  if (fault === "runtime") h.dependencies.verifyRuntime = vi.fn(async () => { throw new Error("closure unavailable"); });
  else if (fault === "spawn") h.dependencies.spawn = vi.fn(() => { throw new Error("spawn unavailable"); });
  else if (fault === "timeout") h.state.ready = false;
  else h.child.write = vi.fn(() => {
    if (fault.startsWith("reply-then")) h.emit(line(ready(h.launch.generation), LIMITS.header));
    if (fault.endsWith("throw")) throw new Error("write failed");
    return Promise.reject(new Error("write failed"));
  });
  const started = h.supervisor.start().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(fault === "timeout" ? 10001 : 0);
  expect(await started).toBeInstanceOf(HistoryUnavailable);
  expect(records(h).every((record) => record.last_ready === null && record.adapter_worker !== "ok")).toBe(true);
  expect(h.supervisor.status().last_ready).toBeNull();
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
});

it("retains earlier observed identity across a failed later generation without treating it as current READY", async () => {
  const h = workerHarness(); await h.supervisor.start(); await h.supervisor.stop();
  const prior: LifecycleRecord = structuredClone(h.supervisor.status());
  h.dependencies.readLifecycle = vi.fn(async () => prior);
  h.child.write = vi.fn(async () => { h.emit(line({ ...ready(h.launch.generation), capability: "association-only/v1" }, LIMITS.header)); });
  const previousWrites = records(h).length;
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.launch.generation).not.toBe(prior.last_ready!.generation);
  expect(records(h).slice(previousWrites).every((record) => record.adapter_worker !== "ok" && JSON.stringify(record.last_ready) === JSON.stringify(prior.last_ready))).toBe(true);
  expect(h.supervisor.status()).toEqual(prior);
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).toHaveBeenCalledTimes(2);
});

it("failed persistence of the observed READY inhibits the worker and cannot accept requests", async () => {
  const h = workerHarness();
  h.dependencies.writeLifecycle = vi.fn<SupervisorDependencies["writeLifecycle"]>(async (record) => { if (record.adapter_worker === "ok") throw new Error("journal unavailable"); });
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(records(h).filter((record) => record.last_ready !== null)).toHaveLength(1); // attempted, failed persistence only
  expect(h.supervisor.status()).toMatchObject({ adapter_worker: "unresolved", owned_worker: "unknown", last_ready: null });
  await expect(h.supervisor.call(lookup())).rejects.toBeInstanceOf(HistoryUnavailable);
  await expect(h.supervisor.start()).rejects.toBeInstanceOf(HistoryUnavailable);
  expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
});
