import { vi, type Mock } from "vitest";
import { canonical, digest, line, LIMITS, type Correlation, type Header } from "@/lib/receipts/transport-codec";
import { ReceiptWorkerSupervisor, type Launch, type SupervisorDependencies, type Worker, type WorkerEvents } from "@/lib/receipts/transport-supervisor";
import { devices } from "./receipt-fixtures";

export const transportGeneration = "a".repeat(64);
export const configValue = () => {
  const store = { root: "/synthetic/receipt-state", root_identity: [1, 10], files: { "receipt-engine.sqlite": [1, 11], "store.lock": [1, 12] } };
  const owned = { root: store.root, root_identity: [1, 10], device_root_identity: [1, 13], devices: [...devices].sort(), files: { "operation.lock": [1, 14], "control.lock": [1, 15], ...Object.fromEntries([...devices].sort().map((d, n) => [`device-locks/${d}.lock`, [1, 20 + n]])) } };
  return { schema: "receipt-adapter-worker-config/v1", engine_sha: "b".repeat(40), application_inventory_sha256: "c".repeat(64), store_attestation: store, store_attestation_sha256: digest(Buffer.from(canonical(store))), ownership_attestation: owned, ownership_attestation_sha256: digest(Buffer.from(canonical(owned))), catalog: { revision: 0, devices: devices.map((device_id) => ({ device_id, profile_sha256: null, identity_sha256: null, commissioned_for_orders: false })) }, authority: { schema: "receipt-planning-authority/v1", content_sha256: [], profile_sha256: ["d".repeat(64)], renderer_sha256: "e".repeat(64) } };
};

export function reply(c: Correlation, body: Uint8Array = Buffer.alloc(0), fields: Partial<Header> = {}) {
  const header: Header = { schema: "receipt-adapter-reply/v1", generation: c.generation, call_id: c.call_id, method: c.method, status: "ok", kind: c.method === "lookup_request" ? "absent" : null, body_kind: body.length ? c.method === "content_handles" || c.method === "plan" ? "resolution" : "result" : null, body_bytes: body.length, body_sha256: digest(body), ...fields };
  return Buffer.concat([line(header, LIMITS.header), body]);
}

export function workerHarness() {
  let events!: WorkerEvents; let launch!: Launch; let id = 0;
  const config = configValue(); const configBytes = line(config, LIMITS.config);
  const inputs: Record<string, unknown>[] = [];
  const h = {
    ready: true,
    response: (command: Record<string, unknown>) => reply(command as unknown as Correlation),
    emit: (bytes: Uint8Array) => events.stdout(bytes),
    stderr: (bytes: Uint8Array) => events.stderr(bytes),
    closed: () => events.closed(),
    inputs,
    get launch() { return launch; },
    child: null as unknown as Worker & { write: Mock<Worker["write"]>; signalOwnedGroup: Mock<Worker["signalOwnedGroup"]>; proveClosed: Mock<Worker["proveClosed"]> },
    dependencies: null as unknown as SupervisorDependencies,
  };
  h.child = { pid: 1234, pgid: 1234,
    write: vi.fn(async (bytes: Uint8Array) => {
      const command = JSON.parse(Buffer.from(bytes).toString()); inputs.push(command);
      if (command.schema === "receipt-adapter-start/v1") {
        if (h.ready) events.stdout(line({ schema: "receipt-adapter-ready/v1", generation: launch.generation, pid: h.child.pid, engine_sha: config.engine_sha, application_inventory_sha256: config.application_inventory_sha256, config_sha256: digest(configBytes), capability: "schema7-association-only/v1" }, LIMITS.header));
      } else {
        const bytes = h.response(command);
        if (bytes.length) events.stdout(bytes);
      }
    }),
    signalOwnedGroup: vi.fn<Worker["signalOwnedGroup"]>(),
    proveClosed: vi.fn(async () => ({ exited: true, reaped: true, groupAbsent: true })),
  };
  h.dependencies = {
    verifyRuntime: vi.fn(async () => ({ python: "/synthetic/python", releaseRoot: "/synthetic/protected-release", configPath: "/synthetic/protected-config.json", path: "/usr/bin:/bin", configBytes, configHash: digest(configBytes), checks: { interpreter: true, importClosure: true, protectedAncestorsAndACLs: true, environmentAndCache: true, acceptedConstructor: true } as const })),
    readLifecycle: vi.fn(async () => null),
    provePriorAbsence: vi.fn(async () => true),
    writeLifecycle: vi.fn<SupervisorDependencies["writeLifecycle"]>().mockResolvedValue(undefined),
    spawn: vi.fn((l, e) => { launch = l; events = e; return h.child; }),
    monotonic: () => Date.now(), utcNow: () => new Date().toISOString(),
    nonce: (n) => (++id).toString(16).padStart(n * 2, "0"),
  };
  return { ...h, get launch() { return launch; }, supervisor: new ReceiptWorkerSupervisor(h.dependencies), state: h };
}
