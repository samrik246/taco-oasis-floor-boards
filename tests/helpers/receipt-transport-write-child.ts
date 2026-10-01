// Disposable Node process probe, not a real engine/worker launcher. No rejection
// listener is installed: an unhandled promise must retain Node's exit-1 behavior.
import { readFileSync } from "node:fs";
import { handleReceipt } from "../../src/lib/receipts/host";
import { residentAdapter } from "../../src/lib/receipts/resident-adapter";
import { parseCommand } from "../../src/lib/receipts/protocol";
import { ReceiptWorkerSupervisor, UnknownCompletion, HistoryUnavailable, type WorkerEvents } from "../../src/lib/receipts/transport-supervisor";
import { digest, line, LIMITS, type CallInput } from "../../src/lib/receipts/transport-codec";

async function main() {
  const { config, input } = JSON.parse(readFileSync(0, "utf8")) as { config: { engine_sha: string; application_inventory_sha256: string; catalog: { devices: { device_id: string }[] } }; input: CallInput };
  const [stage, mode] = process.argv.slice(2);
  const configBytes = line(config, LIMITS.config);
  const devices = config.catalog.devices.map((device) => device.device_id);
  let events!: WorkerEvents; let generation = ""; let writes = 0;
  const signals: string[] = [];
  const supervisor = new ReceiptWorkerSupervisor({
    readLifecycle: async () => null, provePriorAbsence: async () => true, writeLifecycle: async () => {},
    verifyRuntime: async () => ({ python: "/synthetic/python", releaseRoot: "/synthetic/release", configPath: "/synthetic/config", path: "/usr/bin:/bin", configBytes, configHash: digest(configBytes), checks: { interpreter: true, importClosure: true, protectedAncestorsAndACLs: true, environmentAndCache: true, acceptedConstructor: true } }),
    monotonic: () => performance.now(), utcNow: () => new Date().toISOString(),
    spawn: (launch, callbacks) => {
      events = callbacks; generation = launch.generation;
      return { pid: 1234, pgid: 1234,
        write(bytes) {
          writes++;
          const starting = JSON.parse(Buffer.from(bytes).toString()).schema === "receipt-adapter-start/v1";
          if (!starting || stage === "startup") {
            if (mode === "throw") throw new Error("synthetic synchronous write failure");
            return Promise.reject(new Error("synthetic rejected write"));
          }
          events.stdout(line({ schema: "receipt-adapter-ready/v1", generation, pid: 1234, engine_sha: config.engine_sha, application_inventory_sha256: config.application_inventory_sha256, config_sha256: digest(configBytes), capability: "schema7-association-only/v1" }, LIMITS.header));
          return Promise.resolve();
        },
        signalOwnedGroup: (signal) => { signals.push(signal); },
        proveClosed: async () => ({ exited: true, reaped: true, groupAbsent: true }),
      };
    },
  });
  let outcome = "unexpected success"; let response: unknown = null;
  try {
    await supervisor.start();
    if (stage === "call") await supervisor.call(input);
    if (stage === "handler") {
      const command = parseCommand((input.args as { browser_command: unknown }).browser_command, devices);
      const request = new Request("http://localhost/api/receipts", { method: "POST", headers: { "content-type": "application/json", "x-manager-session": "synthetic" }, body: JSON.stringify(command) });
      response = await (await handleReceipt(request, { devices, engine: residentAdapter(supervisor, devices), authenticate: async () => input.authenticated_actor })).json();
      outcome = "public_response";
    }
  }
  catch (e) { outcome = e instanceof UnknownCompletion ? "unknown" : e instanceof HistoryUnavailable ? "history_unavailable" : "unexpected error"; }
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.stdout.write(JSON.stringify({ stage, mode, outcome, response, signals, writes, status: supervisor.status() }) + "\n");
}
void main().catch(() => { process.exitCode = 2; });
