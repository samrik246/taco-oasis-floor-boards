import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  acquire: vi.fn(), release: vi.fn(), check: vi.fn(), state: vi.fn(), close: vi.fn(),
  compatible: vi.fn(), run: vi.fn(), enter: vi.fn(), events: [] as string[],
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/quarter/lease", () => ({
  quarterLeaseAppDir: async () => "/synthetic/app",
  withClaimedReleaseLease: async (_app: string, work: () => Promise<unknown>) => { f.events.push("claim"); f.enter(); return work(); },
}));
vi.mock("@/lib/quarter/importer-identity", () => ({ importerIdentity: async () => ({ check: f.check, state: f.state, close: f.close }) }));
vi.mock("@/lib/quarter/compatibility", () => ({ assertArtifactCompatibility: f.compatible }));
vi.mock("@/lib/release-lock", () => ({ acquireReleaseLockForPull: f.acquire, releaseReleaseLock: f.release }));
vi.mock("@/lib/wiw-export/run", () => ({ runWiwExport: f.run }));
import { runScheduledExport } from "@/lib/wiw-export/scheduled-run";
import type { WiwExportDeps } from "@/lib/wiw-export/run";

const settings = { appDir: "/synthetic/app", importDir: "/synthetic/import", loginFile: "/synthetic/no-login", profileDir: "/synthetic/no-profile", logFile: "/synthetic/log", importMode: "apply" as const };
beforeEach(() => {
  vi.resetAllMocks(); f.events = [];
  f.check.mockImplementation(() => { f.events.push("pin"); });
  f.state.mockImplementation(async () => { f.events.push("running"); });
  f.compatible.mockImplementation(async () => { f.events.push("schema"); });
});
it("does not construct the provider while the real release acquisition is waiting", async () => {
  let admit!: () => void;
  f.acquire.mockImplementation(() => new Promise<void>(resolve => { admit = resolve; }));
  const provider = vi.fn(() => { f.events.push("provider"); return {} as WiwExportDeps; });
  const pending = runScheduledExport(settings, provider);
  await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce());
  expect(provider).not.toHaveBeenCalled(); expect(f.state).not.toHaveBeenCalled();
  admit(); await pending;
  expect(f.events).toEqual(["claim", "pin", "running", "schema", "provider"]);
  expect(f.release).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});
it.each(["pin", "schema", "claim"])("refuses %s failure before the provider and releases owned resources", async boundary => {
  const failure = new Error("BOUNDARY_CHANGED");
  (boundary === "pin" ? f.check : boundary === "schema" ? f.compatible : f.enter).mockImplementation(() => { throw failure; });
  const provider = vi.fn();
  await expect(runScheduledExport(settings, provider)).rejects.toBe(failure);
  expect(provider).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});
it("retains the original provider failure and closes the lease and identity", async () => {
  const failure = new Error("PROVIDER_FAILED");
  await expect(runScheduledExport(settings, () => { throw failure; })).rejects.toBe(failure);
  expect(f.release).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});
