import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, rmSync, renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const f = vi.hoisted(() => ({ app: "", pin: "a".repeat(64), synthetic: vi.fn(), schema: vi.fn() }));
vi.mock("@/lib/quarter/artifact-root", () => ({ artifactAppDir: () => f.app }));
vi.mock("@/lib/quarter/artifact", () => ({ get loadedArtifactSha256() { return f.pin; }, verifiedArtifact: () => ({ scope: "runtime", schemaSha256: "b".repeat(64) }) }));
vi.mock("@/lib/quarter/test-boundary", () => ({ assertSyntheticDatabase: f.synthetic }));
vi.mock("@/lib/quarter/schema", async original => ({ ...await original<typeof import("@/lib/quarter/schema")>(), quarterState: f.schema }));
import { canonical, type QuarterDb } from "@/lib/quarter/schema";
import { attestServiceStartup } from "@/lib/quarter/service-startup";
let root: string, database: string, contract: Record<string, unknown>;
const priorUrl = process.env.DATABASE_URL;
beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(path.join(process.env.FLOOR_BOARDS_TEST_ROOT!, "startup-"));
  f.app = path.join(root, "app"); mkdirSync(path.join(f.app, "var/run"), { recursive: true });
  database = path.join(root, "data.db"); writeFileSync(database, "synthetic");
  const stat = statSync(database);
  contract = { version: 1, nonce: randomUUID(), app: f.app, database, databaseIdentity: { device: stat.dev, inode: stat.ino }, artifactSha256: f.pin, profileSha256: "c".repeat(64) };
  writeContract(); process.env.DATABASE_URL = "file:" + database;
  f.schema.mockResolvedValue({ databaseEpoch: "synthetic-epoch" });
});
afterEach(() => { process.env.DATABASE_URL = priorUrl; vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function writeContract() { writeFileSync(path.join(f.app, "var/run/quarter-start-contract.json"), canonical(contract) + "\n"); }
function client(file = database) {
  const query = vi.fn().mockResolvedValue([{ name: "main", file }]);
  return { db: { $queryRawUnsafe: query } as unknown as QuarterDb, query };
}
it("binds actual opened database and process identity before publishing readiness", async () => {
  const { db } = client(); const compatible = vi.fn().mockResolvedValue(undefined);
  await attestServiceStartup(db, compatible);
  expect(compatible).toHaveBeenCalledOnce();
  const receipt = JSON.parse(readFileSync(path.join(f.app, "var/run/quarter-start-receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ pid: process.pid, nonce: contract.nonce, databaseIdentity: contract.databaseIdentity, databaseEpoch: "synthetic-epoch", artifactSha256: f.pin });
});
it.each(["configured", "inode", "artifact"])("refuses changed %s identity before a database query", async boundary => {
  if (boundary === "configured") process.env.DATABASE_URL = "file:/synthetic/wrong.db";
  if (boundary === "inode") { renameSync(database, database + ".old"); writeFileSync(database, "replacement"); }
  if (boundary === "artifact") { contract.artifactSha256 = "d".repeat(64); writeContract(); }
  const { db, query } = client();
  await expect(attestServiceStartup(db, vi.fn())).rejects.toMatchObject({ code: "SERVICE_STARTUP_IDENTITY_MISMATCH" });
  expect(query).not.toHaveBeenCalled();
});
it("refuses an opened-file mismatch and incompatible runtime without readiness", async () => {
  const { db } = client(database + ".other"), compatible = vi.fn();
  await expect(attestServiceStartup(db, compatible)).rejects.toMatchObject({ code: "SERVICE_STARTUP_IDENTITY_MISMATCH" });
  expect(compatible).not.toHaveBeenCalled();
  const correct = client(); compatible.mockRejectedValue(new Error("INCOMPATIBLE"));
  await expect(attestServiceStartup(correct.db, compatible)).rejects.toThrow("INCOMPATIBLE");
  expect(() => readFileSync(path.join(f.app, "var/run/quarter-start-receipt.json"))).toThrow();
});
it("requires a managed contract outside positively guarded disposable fixtures", async () => {
  rmSync(path.join(f.app, "var/run/quarter-start-contract.json"));
  vi.stubEnv("FLOOR_BOARDS_TEST_ROOT", undefined);
  await expect(attestServiceStartup(client().db, vi.fn())).rejects.toMatchObject({ code: "SERVICE_STARTUP_IDENTITY_MISMATCH" });
  expect(f.synthetic).not.toHaveBeenCalled();
});
