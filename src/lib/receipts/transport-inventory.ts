import { z } from "zod";
import { canonical, decodeLine, digest, hashSchema, LIMITS, safeInteger, sha1Schema } from "./transport-codec";
import { parseWorkerConfig } from "./transport-config";

export const INVENTORY_LIMITS = { object: 1048576, file: 1048577, entries: 4096 } as const;
export const INVENTORY_SIDECAR = "receipt-application-inventory.json";
const absolutePath = z.string().refine((s) => s.startsWith("/") && !s.includes("\0") && !/[\ud800-\udfff]/u.test(s)
  && (s === "/" || s.slice(1).split("/").every((p) => p !== "" && p !== "." && p !== "..")), "canonical absolute path");
const filePath = absolutePath.refine((s) => s !== "/", "file path");
const file = z.object({ path: filePath, size: safeInteger, sha256: hashSchema }).strict();
const origin = z.enum(["release", "stdlib", "native"]);
const entry = file.extend({ origin }).strict();
const inventorySchema = z.object({
  schema: z.literal("receipt-application-inventory/v1"), engine_sha: sha1Schema, release_root: filePath,
  interpreter: z.object({ version: z.literal("3.13.15"), launcher: file, app_stub: file, framework: file, team_id: z.literal("BMM5U3QVKW") }).strict(),
  files: z.array(entry).min(1).max(INVENTORY_LIMITS.entries),
}).strict();
export type ApplicationInventory = z.infer<typeof inventorySchema>;
const bindingSchema = z.object({ releaseRoot: filePath, configPath: filePath, engineSha: sha1Schema, inventoryHash: hashSchema }).strict();
export type InventoryBinding = z.infer<typeof bindingSchema>;

/** Python's scalar ordering, not JS UTF-16 ordering or locale collation. */
export function compareScalarPaths(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!); const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}

/** Exact sidecar bytes; SHA covers C, while the file is C plus exactly one LF. */
export function parseApplicationInventory(input: Uint8Array, expected: InventoryBinding): ApplicationInventory {
  const binding = bindingSchema.parse(expected);
  if (input.byteLength > INVENTORY_LIMITS.file) throw new Error("inventory size");
  const bytes = Uint8Array.from(input);
  const value = inventorySchema.parse(decodeLine(bytes, INVENTORY_LIMITS.file));
  if (digest(bytes.subarray(0, -1)) !== binding.inventoryHash) throw new Error("inventory digest");
  if (value.release_root !== binding.releaseRoot || value.engine_sha !== binding.engineSha) throw new Error("inventory binding");
  const sidecar = `${value.release_root}/${INVENTORY_SIDECAR}`;
  if (sidecar === binding.configPath) throw new Error("separate config");
  const images = [value.interpreter.launcher, value.interpreter.app_stub, value.interpreter.framework];
  for (const image of images) {
    if (image.path === binding.configPath || image.path === sidecar) throw new Error("input is executable");
    for (const other of images) if (image.path === other.path && (image.size !== other.size || image.sha256 !== other.sha256)) throw new Error("interpreter alias");
  }
  for (let i = 0; i < value.files.length; i++) {
    const current = value.files[i];
    if (i && compareScalarPaths(value.files[i - 1].path, current.path) >= 0) throw new Error("inventory order/duplicate");
    if (current.path === sidecar || current.path === binding.configPath) throw new Error("self hash");
    if (current.origin === "release" && !current.path.startsWith(value.release_root + "/")) throw new Error("release path");
    for (const image of images) if (current.path === image.path && (current.origin !== "native" || current.size !== image.size || current.sha256 !== image.sha256)) throw new Error("interpreter entry");
  }
  return freeze(value);
}

const metadata = z.object({
  dev: safeInteger, ino: safeInteger, size: safeInteger, links: safeInteger,
  kind: z.enum(["file", "directory"]), uid: safeInteger, gid: safeInteger, mode: z.number().int().min(0).max(0o7777),
  // Decimal nanoseconds avoid losing real OS timestamp precision in JS numbers.
  mtimeNs: z.string().regex(/^(0|[1-9][0-9]*)$/).max(32), ctimeNs: z.string().regex(/^(0|[1-9][0-9]*)$/).max(32),
  aclEvaluated: z.literal(true), aclMutation: z.literal(false), noSymlinkTraversal: z.literal(true),
}).strict();
const snapshot = z.object({ descriptor: metadata, pathname: metadata, ancestors: z.array(z.object({ path: absolutePath, metadata }).strict()).min(1).max(4096) }).strict();
const readSchema = z.object({ bytes: z.instanceof(Uint8Array), before: snapshot, after: snapshot }).strict();
export type ProtectedInventoryRead = z.infer<typeof readSchema>;
const identitySchema = z.object({ uid: safeInteger, groups: z.array(safeInteger).min(1).max(1024), verified: z.literal(true) }).strict();
const closureSchema = z.object({
  files: z.array(z.object({ path: filePath, origin }).strict()).min(1).max(INVENTORY_LIMITS.entries),
  builtins: z.array(z.object({ module: z.string().min(1).max(256), image: filePath }).strict()).max(4096),
  complete: z.literal(true), operationClosure: z.literal(true), supportedImageStorage: z.literal(true),
}).strict();
const intakeBinding = z.object({
  releaseRoot: filePath, packageRoot: filePath, python: filePath, configPath: filePath, configHash: hashSchema, engineSha: sha1Schema,
}).strict();
export type InventoryIntakeBinding = z.infer<typeof intakeBinding>;
export type InventoryDependencies = {
  /** Trusted H inputs only. No real reader/ACL/closure implementation is installed.
   * read must enforce limit while reading without symlink traversal, and bind all
   * snapshots to that same opened descriptor/byte stream. Unknown proof refuses. */
  serviceIdentity(): Promise<z.infer<typeof identitySchema>>;
  read(path: string, limit: number): Promise<ProtectedInventoryRead>;
  closure(): Promise<z.infer<typeof closureSchema>>;
};

function ancestors(path: string): string[] {
  const parts = path.slice(1).split("/"); parts.pop();
  return ["/", ...parts.map((_, n) => "/" + parts.slice(0, n + 1).join("/"))];
}
function protectedMetadata(m: z.infer<typeof metadata>, identity: z.infer<typeof identitySchema>) {
  // Ownership permits chmod even when mode write bits are clear. ACL denial
  // cannot neutralize ownership, group or other independent write authority.
  if (m.uid === identity.uid || (m.mode & 0o002) || (identity.groups.includes(m.gid) && (m.mode & 0o020))) throw new Error("mutable path");
}

/** A synthetic-testable intake for a future parent H. It never spawns, qualifies
 * a runtime, repairs inputs or supplies VerifiedRuntime. Real protection, full
 * closure, native shared-cache coverage and OS proof remain separate gates. */
export async function intakeApplicationInventory(expected: InventoryIntakeBinding, dependencies?: InventoryDependencies) {
  if (!dependencies) throw new Error("inventory verifier unavailable");
  const binding = intakeBinding.parse(expected);
  if (binding.packageRoot !== binding.releaseRoot) throw new Error("package root");
  const sidecar = `${binding.releaseRoot}/${INVENTORY_SIDECAR}`;
  if (sidecar === binding.configPath) throw new Error("separate config");
  const identity = identitySchema.parse(await dependencies.serviceIdentity());
  if (identity.uid === 0 || new Set(identity.groups).size !== identity.groups.length) throw new Error("service identity");
  const retained = new Map<string, string>();
  async function read(path: string, limit: number): Promise<Uint8Array> {
    const result = readSchema.parse(await dependencies!.read(path, limit));
    if (result.bytes.byteLength > limit) throw new Error("read bound");
    const bytes = Uint8Array.from(result.bytes);
    const { before, after } = result;
    if (canonical(before) !== canonical(after) || canonical(before.descriptor) !== canonical(before.pathname)) throw new Error("replaced file");
    if (before.descriptor.kind !== "file" || before.descriptor.links !== 1 || before.descriptor.size !== bytes.length) throw new Error("file metadata");
    const filePin = canonical(before.descriptor); const priorFile = retained.get(path);
    if (priorFile && priorFile !== filePin) throw new Error("file changed");
    retained.set(path, filePin);
    const expectedAncestors = ancestors(path);
    if (canonical(before.ancestors.map((a) => a.path)) !== canonical(expectedAncestors)) throw new Error("ancestor coverage");
    protectedMetadata(before.descriptor, identity);
    for (const a of before.ancestors) {
      if (a.metadata.kind !== "directory") throw new Error("ancestor kind");
      protectedMetadata(a.metadata, identity);
      const pin = canonical(a.metadata); const earlier = retained.get(a.path);
      if (earlier && earlier !== pin) throw new Error("ancestor changed");
      retained.set(a.path, pin);
    }
    return bytes;
  }
  const configBytes = await read(binding.configPath, LIMITS.config);
  const config = parseWorkerConfig(configBytes, binding.configHash);
  if (config.engine_sha !== binding.engineSha) throw new Error("config engine");
  const inventoryBytes = await read(sidecar, INVENTORY_LIMITS.file);
  const inventory = parseApplicationInventory(inventoryBytes, { releaseRoot: binding.releaseRoot, configPath: binding.configPath, engineSha: binding.engineSha, inventoryHash: config.application_inventory_sha256 });
  if (inventory.interpreter.launcher.path !== binding.python) throw new Error("interpreter path");
  const closure = closureSchema.parse(await dependencies.closure());
  const observed = [...closure.files].sort((a, b) => compareScalarPaths(a.path, b.path));
  if (canonical(observed) !== canonical(inventory.files.map(({ path, origin }) => ({ path, origin })))) throw new Error("closure coverage");
  const images = [inventory.interpreter.launcher, inventory.interpreter.app_stub, inventory.interpreter.framework];
  if (new Set(closure.builtins.map((b) => b.module)).size !== closure.builtins.length || closure.builtins.some((b) => !images.some((i) => i.path === b.image))) throw new Error("builtin coverage");
  const files = new Map([...images, ...inventory.files].map((f) => [f.path, f]));
  for (const f of files.values()) {
    const bytes = await read(f.path, f.size);
    if (bytes.byteLength !== f.size || digest(bytes) !== f.sha256) throw new Error("executable content");
  }
  // Config and sidecar are separate pinned inputs; never put them in files.
  // Re-read them after dependency work, still under the same snapshot contract.
  if (digest(await read(binding.configPath, LIMITS.config)) !== binding.configHash
    || !Buffer.from(await read(sidecar, INVENTORY_LIMITS.file)).equals(Buffer.from(inventoryBytes))) throw new Error("input changed");
  return freeze({ inventory, config, inventoryPath: sidecar, configPath: binding.configPath });
}
