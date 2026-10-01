import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseWorkerConfig, type WorkerConfig } from "./transport-config";
import { digest, hashSchema, LIMITS, line, prepareCall, ReadyCollector, ReplyCollector, type CallInput, type Frame } from "./transport-codec";

export class HistoryUnavailable extends Error { constructor() { super("history_unavailable"); } }
export class UnknownCompletion extends Error { constructor() { super("result_unconfirmed"); } }
export type LifecycleRecord = { adapter_worker: "ok" | "unavailable" | "unresolved"; generation: string | null; pid: number | null; owned_worker: 0 | 1 | "unknown" };
export type ExitProof = { exited: boolean; reaped: boolean; groupAbsent: boolean };
export type WorkerEvents = { stdout(bytes: Uint8Array): void; stderr(bytes: Uint8Array): void; closed(): void; error(): void };
export type Worker = {
  readonly pid: number; readonly pgid: number;
  write(bytes: Uint8Array): Promise<void>;
  signalOwnedGroup(signal: "TERM" | "KILL"): void;
  // The real implementation must bind this proof to its own actual spawn,
  // including descendants and process identity; PID/pipe closure is insufficient.
  proveClosed(): Promise<ExitProof>;
};
export type Launch = { executable: string; argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; generation: string };
export type VerifiedRuntime = {
  python: string; releaseRoot: string; configPath: string; path: string;
  configBytes: Uint8Array; configHash: string;
  checks: { interpreter: true; importClosure: true; protectedAncestorsAndACLs: true; environmentAndCache: true; acceptedConstructor: true };
};
export type SupervisorDependencies = {
  // No implementation is installed. Fakes supply these proofs; real H predicates,
  // protected release provisioning and the compatible engine require judgment.
  verifyRuntime(): Promise<VerifiedRuntime>;
  readLifecycle(): Promise<LifecycleRecord | null>;
  provePriorAbsence(record: LifecycleRecord | null): Promise<boolean>;
  writeLifecycle(record: LifecycleRecord): Promise<void>;
  spawn(launch: Launch, events: WorkerEvents): Worker;
  monotonic(): number;
  utcNow(): string;
  nonce?(bytes: number): string;
};

type Queued = { prepared: ReturnType<typeof prepareCall>; expires: number; timer: ReturnType<typeof setTimeout>; resolve(frame: Frame): void; reject(error: Error): void };
const absent = (): LifecycleRecord => ({ adapter_worker: "unavailable", generation: null, pid: null, owned_worker: 0 });
const unknown = (): LifecycleRecord => ({ adapter_worker: "unresolved", generation: null, pid: null, owned_worker: "unknown" });
const runtimeChecks = z.object({ interpreter: z.literal(true), importClosure: z.literal(true), protectedAncestorsAndACLs: z.literal(true), environmentAndCache: z.literal(true), acceptedConstructor: z.literal(true) }).strict();
const absolute = (value: string) => { if (!value.startsWith("/") || value.includes("\0")) throw new Error("trusted path"); return value; };

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new UnknownCompletion()), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Explicit lifecycle only. Receipt calls cannot start or restart a worker. */
export class ReceiptWorkerSupervisor {
  private state: LifecycleRecord = unknown();
  private worker: Worker | null = null;
  private spawnProvenance = false;
  private config: WorkerConfig | null = null;
  private starting: Promise<void> | null = null;
  private cleanup: Promise<void> | null = null;
  private epoch = 0;
  private stderrBytes = 0;
  private startup: { collector: ReadyCollector; resolve(value: unknown): void; reject(error: Error): void } | null = null;
  private active: { collector: ReplyCollector; resolve(frame: Frame): void; reject(error: Error): void } | null = null;
  private queue: Queued[] = [];
  private pumping = false;
  private journal = Promise.resolve();
  constructor(private readonly dependencies: SupervisorDependencies) {}
  status(): LifecycleRecord { return { ...this.state }; }

  private async record(value: LifecycleRecord) {
    const epoch = this.epoch;
    const copy = Object.freeze({ ...value });
    const next = this.journal.then(() => this.dependencies.writeLifecycle(copy));
    this.journal = next.catch(() => {});
    try { await next; if (epoch === this.epoch) this.state = { ...value }; }
    catch { this.state = { ...this.state, adapter_worker: "unresolved", owned_worker: "unknown" }; throw new HistoryUnavailable(); }
  }

  start(): Promise<void> {
    if (this.starting || this.cleanup || this.worker) return Promise.reject(new HistoryUnavailable());
    const epoch = ++this.epoch;
    const work = this.startWorker(epoch);
    this.starting = work;
    void work.finally(() => { if (this.starting === work) this.starting = null; }).catch(() => {});
    return work;
  }

  private async startWorker(epoch: number) {
    try {
      const prior = await this.dependencies.readLifecycle();
      if (!await this.dependencies.provePriorAbsence(prior)) { await this.record({ ...(prior ?? unknown()), adapter_worker: "unresolved", owned_worker: "unknown" }); throw new HistoryUnavailable(); }
      await this.record(absent());
      const runtime = await bounded(this.dependencies.verifyRuntime(), 10000);
      runtimeChecks.parse(runtime.checks);
      const bytes = Uint8Array.from(runtime.configBytes);
      const config = parseWorkerConfig(bytes, runtime.configHash);
      absolute(runtime.python); absolute(runtime.releaseRoot); absolute(runtime.configPath);
      if (!runtime.path || runtime.path.includes("\0")) throw new Error("path");
      if (this.epoch !== epoch) throw new HistoryUnavailable();
      const generation = hashSchema.parse((this.dependencies.nonce ?? ((n) => randomBytes(n).toString("hex")))(32));
      this.config = config;
      this.stderrBytes = 0;
      await this.record({ adapter_worker: "unresolved", generation, pid: null, owned_worker: "unknown" });
      if (this.epoch !== epoch) throw new HistoryUnavailable();
      const configHash = digest(bytes);
      const launch = Object.freeze({ executable: runtime.python,
        argv: Object.freeze(["-S", "-B", "-m", "packing_ticket.receipt_adapter_worker", "--config", runtime.configPath, "--config-sha256", configHash]),
        cwd: runtime.releaseRoot, generation,
        env: Object.freeze({ PATH: runtime.path, PYTHONPATH: runtime.releaseRoot, PYTHONIOENCODING: "utf-8", LANG: "en_US.UTF-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONPYCACHEPREFIX: "/var/empty" }),
      });
      let resolveReady!: (v: unknown) => void; let rejectReady!: (e: Error) => void;
      const ready = new Promise<unknown>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      // Install a rejection observer before a child can report an immediate fault.
      void ready.catch(() => {});
      this.startup = { collector: new ReadyCollector(), resolve: resolveReady, reject: rejectReady };
      const events: WorkerEvents = {
        stdout: (data) => this.output(epoch, data),
        stderr: (data) => { if (epoch !== this.epoch) return; this.stderrBytes += data.byteLength; if (this.stderrBytes > LIMITS.stderr) void this.retire(); },
        closed: () => { if (epoch === this.epoch) void this.retire(); },
        error: () => { if (epoch === this.epoch) void this.retire(); },
      };
      this.spawnProvenance = false;
      this.worker = this.dependencies.spawn(launch, events);
      const child = this.worker;
      if (!Number.isSafeInteger(child.pid) || child.pid < 1 || child.pgid !== child.pid) throw new Error("spawn provenance");
      this.spawnProvenance = true;
      await this.record({ adapter_worker: "unavailable", generation, pid: child.pid, owned_worker: 1 });
      if (epoch !== this.epoch) throw new HistoryUnavailable();
      const startBytes = line({ schema: "receipt-adapter-start/v1", generation, config_sha256: configHash }, LIMITS.header);
      const [raw] = await bounded(Promise.all([ready, child.write(startBytes)]), 10000);
      const checked = raw as ReturnType<ReadyCollector["push"]>;
      if (!checked || checked.generation !== generation || checked.pid !== child.pid || checked.config_sha256 !== configHash || checked.engine_sha !== config.engine_sha || checked.application_inventory_sha256 !== config.application_inventory_sha256 || epoch !== this.epoch) throw new Error("ready identity");
      this.startup = null;
      await this.record({ adapter_worker: "ok", generation, pid: child.pid, owned_worker: 1 });
      if (epoch !== this.epoch) throw new HistoryUnavailable();
    } catch {
      if (this.worker) await this.retire();
      else this.state.adapter_worker = this.state.owned_worker === 0 ? "unavailable" : "unresolved";
      throw new HistoryUnavailable();
    }
  }

  private output(epoch: number, bytes: Uint8Array) {
    if (epoch !== this.epoch || !bytes.length) return;
    try {
      if (this.startup) { const ready = this.startup.collector.push(bytes); if (ready) this.startup.resolve(ready); }
      else if (this.active) { const frame = this.active.collector.push(bytes); if (frame) this.active.resolve(frame); }
      else throw new Error("idle output");
    } catch { void this.retire(); }
  }

  call(input: CallInput): Promise<Frame> {
    if (this.state.adapter_worker !== "ok" || !this.state.generation || !this.config || !this.worker) return Promise.reject(new HistoryUnavailable());
    let prepared: ReturnType<typeof prepareCall>;
    try { prepared = prepareCall(input, { generation: this.state.generation, call_id: (this.dependencies.nonce ?? ((n) => randomBytes(n).toString("hex")))(16), method: input.method }, this.config.catalog.devices.map((d) => d.device_id)); }
    catch { return Promise.reject(new UnknownCompletion()); }
    if (this.queue.length >= 32) return Promise.reject(new HistoryUnavailable());
    return new Promise<Frame>((resolve, reject) => {
      const entry: Queued = { prepared, expires: this.dependencies.monotonic() + 2000, resolve, reject, timer: setTimeout(() => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) { this.queue.splice(index, 1); reject(new HistoryUnavailable()); }
      }, 2000) };
      this.queue.push(entry); void this.pump();
    });
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.state.adapter_worker === "ok" && this.worker) {
        const entry = this.queue.shift()!; clearTimeout(entry.timer);
        if (this.dependencies.monotonic() >= entry.expires) { entry.reject(new HistoryUnavailable()); continue; }
        const epoch = this.epoch; const child = this.worker;
        const reply = new Promise<Frame>((resolve, reject) => { this.active = { collector: new ReplyCollector(entry.prepared.correlation), resolve, reject }; });
        void reply.catch(() => {});
        try {
          const bytes = entry.prepared.dispatch(this.dependencies.utcNow());
          const [frame] = await bounded(Promise.all([reply, child.write(bytes)]), 10000);
          if (epoch !== this.epoch || this.state.adapter_worker !== "ok" || frame.header.status === "unknown") throw new UnknownCompletion();
          this.active = null;
          entry.resolve(frame);
        } catch {
          await this.retire(); entry.reject(new UnknownCompletion());
        }
      }
    } finally { this.pumping = false; }
  }

  /** Stop is lifecycle-only; it never retries a request or adopts a process. */
  stop(): Promise<void> { return this.retire(); }
  private retire(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    ++this.epoch;
    this.state.adapter_worker = "unavailable";
    this.startup?.reject(new UnknownCompletion()); this.startup = null;
    this.active?.reject(new UnknownCompletion()); this.active = null;
    for (const item of this.queue.splice(0)) { clearTimeout(item.timer); item.reject(new HistoryUnavailable()); }
    const work = Promise.resolve().then(async () => {
      const child = this.worker;
      if (!child) return;
      if (!this.spawnProvenance) { await this.record({ ...this.state, adapter_worker: "unresolved", owned_worker: "unknown" }); return; }
      let ended = false;
      for (const signal of ["TERM", "KILL"] as const) {
        const started = this.dependencies.monotonic();
        try {
          child.signalOwnedGroup(signal);
          const proof = await bounded(child.proveClosed(), 2000);
          if (proof.exited && proof.reaped && proof.groupAbsent) { ended = true; break; }
        } catch { /* Unknown cleanup is retained, never inferred from an exit event. */ }
        const remaining = Math.max(0, 2000 - (this.dependencies.monotonic() - started));
        if (remaining) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      }
      if (ended) { this.worker = null; this.config = null; await this.record(absent()); }
      else await this.record({ ...this.state, adapter_worker: "unresolved", owned_worker: "unknown" });
    }).catch(() => { this.state = { ...this.state, adapter_worker: "unresolved", owned_worker: "unknown" }; });
    this.cleanup = work;
    void work.finally(() => { if (this.cleanup === work) this.cleanup = null; });
    return work;
  }
}
