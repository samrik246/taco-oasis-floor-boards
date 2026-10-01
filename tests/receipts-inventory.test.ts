import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { canonical, digest, line, LIMITS } from "@/lib/receipts/transport-codec";
import { compareScalarPaths, intakeApplicationInventory, INVENTORY_LIMITS, INVENTORY_SIDECAR, parseApplicationInventory, type ApplicationInventory, type InventoryDependencies, type InventoryIntakeBinding, type ProtectedInventoryRead } from "@/lib/receipts/transport-inventory";
import { configValue } from "./helpers/receipt-transport";

const root = "/synthetic/release"; const configPath = "/synthetic/config.json";
const contents = new Map<string, Buffer>([
  ["/runtime/python", Buffer.from("launcher")], ["/runtime/app", Buffer.from("app")], ["/runtime/framework", Buffer.from("framework")],
  [root + "/worker.py", Buffer.from("worker")], ["/runtime/stdlib.py", Buffer.from("stdlib")], ["/runtime/sqlite.so", Buffer.from("native")],
]);
const file = (path: string) => ({ path, size: contents.get(path)!.length, sha256: digest(contents.get(path)!) });
function inventory(): ApplicationInventory {
  return { schema: "receipt-application-inventory/v1", engine_sha: "b".repeat(40), release_root: root,
    interpreter: { version: "3.13.15", launcher: file("/runtime/python"), app_stub: file("/runtime/app"), framework: file("/runtime/framework"), team_id: "BMM5U3QVKW" },
    files: [...contents.keys()].map((path) => ({ ...file(path), origin: path.startsWith(root + "/") ? "release" as const : path.endsWith("stdlib.py") ? "stdlib" as const : "native" as const })).sort((a, b) => compareScalarPaths(a.path, b.path)),
  };
}
function encoded(value = inventory()) { return line(value, INVENTORY_LIMITS.file); }
function binding(bytes: Uint8Array) { return { releaseRoot: root, configPath, engineSha: "b".repeat(40), inventoryHash: digest(bytes.subarray(0, -1)) }; }
function parse(value = inventory()) { const bytes = encoded(value); return parseApplicationInventory(bytes, binding(bytes)); }
const valid = encoded();

describe("application inventory exact bytes", () => {
  it("accepts canonical scalar UTF-8, escaped controls and maximum safe sizes against a Python golden", () => {
    const bytes = readFileSync("fixtures/receipts/application-inventory-v1.json");
    const expected = JSON.parse(readFileSync("fixtures/receipts/application-inventory-v1-sha.json", "utf8"));
    expect(digest(bytes.subarray(0, -1))).toBe(expected.object_sha256);
    expect(digest(bytes)).toBe(expected.file_sha256);
    const result = parseApplicationInventory(bytes, binding(bytes));
    expect(result.files.map((f) => f.path)).toEqual([root + "/control\n\t\u0001.py", root + "/\ue000.py", root + "/\u{10000}.py"]);
    expect(result.files[0].size).toBe(Number.MAX_SAFE_INTEGER);
    expect(Object.isFrozen(result.files[0])).toBe(true);
  });
  it("hashes the object, never the whole sidecar", () => { expect(() => parseApplicationInventory(valid, { ...binding(valid), inventoryHash: digest(valid) })).toThrow("digest"); });
  it.each(["missing LF", "extra LF", "CRLF", "leading LF", "BOM", "whitespace", "keys", "escape", "duplicate", "UTF8", "surrogate", "fraction", "unsafe", "negative zero"])("refuses %s without normalization", (kind) => {
    const raw = valid.toString();
    const variants: Record<string, Buffer> = {
      "missing LF": valid.subarray(0, -1), "extra LF": Buffer.concat([valid, Buffer.from("\n")]), CRLF: Buffer.from(raw.slice(0, -1) + "\r\n"), "leading LF": Buffer.concat([Buffer.from("\n"), valid]), BOM: Buffer.concat([Buffer.from([239, 187, 191]), valid]),
      whitespace: Buffer.from(" " + raw), keys: Buffer.from(JSON.stringify(inventory()) + "\n"), escape: Buffer.from(raw.replace("/synthetic", "\\/synthetic")), duplicate: Buffer.from(raw.replace('{"engine_sha":', '{"schema":"receipt-application-inventory/v1","engine_sha":')),
      UTF8: Buffer.concat([Buffer.from([255]), valid]), surrogate: Buffer.from(raw.replace("/worker.py", "/\\ud800.py")), fraction: Buffer.from(raw.replace('"size":3', '"size":3.1')), unsafe: Buffer.from(raw.replace('"size":3', '"size":9007199254740992')), "negative zero": Buffer.from(raw.replace('"size":3', '"size":-0')),
    };
    const bytes = variants[kind]; expect(bytes.equals(valid)).toBe(false);
    expect(() => parseApplicationInventory(bytes, binding(bytes))).toThrow();
  });
  it.each(["root", "interpreter", "launcher", "entry"])("refuses unknown %s keys", (location) => {
    const v = inventory(); const target = { root: v, interpreter: v.interpreter, launcher: v.interpreter.launcher, entry: v.files[0] }[location];
    Object.assign(target, { unknown: true }); expect(() => parse(v)).toThrow();
  });
  it.each(["schema", "version", "team", "origin", "size-string", "negative-size", "hash", "empty", "duplicate", "reversed", "release-outside", "interpreter-hash", "interpreter-origin", "self", "config"])("refuses closed contract defect %s", (kind) => {
    const v = inventory();
    if (kind === "schema") Object.assign(v, { schema: "other" });
    if (kind === "version") Object.assign(v.interpreter, { version: "3.13.14" });
    if (kind === "team") Object.assign(v.interpreter, { team_id: "other" });
    if (kind === "origin") Object.assign(v.files[0], { origin: "system" });
    if (kind === "size-string") Object.assign(v.files[0], { size: "3" });
    if (kind === "negative-size") v.files[0].size = -1;
    if (kind === "hash") v.files[0].sha256 = "A".repeat(64);
    if (kind === "empty") v.files = [];
    if (kind === "duplicate") v.files.splice(0, 0, { ...v.files[0] });
    if (kind === "reversed") v.files.reverse();
    if (kind === "release-outside") v.files[0].origin = "release";
    if (kind === "interpreter-hash") v.interpreter.app_stub.sha256 = "a".repeat(64);
    if (kind === "interpreter-origin") v.files[0].origin = "stdlib";
    if (kind === "self") v.files.push({ ...v.files.at(-1)!, path: root + "/" + INVENTORY_SIDECAR });
    if (kind === "config") v.files.push({ ...v.files.at(-1)!, path: configPath, origin: "stdlib" });
    if (kind === "self" || kind === "config") v.files.sort((a, b) => compareScalarPaths(a.path, b.path));
    expect(() => parse(v)).toThrow();
  });
  it.each(["relative", "/", "//file", "/a//b", "/a/./b", "/a/../b", "/a/", "/a\0b", "/a\udfff"])("refuses noncanonical path %j", (path) => {
    const v = inventory(); v.files = [{ ...v.files[0], path, origin: "stdlib" }]; expect(() => parse(v)).toThrow();
  });
  it("accepts 4096 files, refuses 4097", () => {
    const v = inventory(); v.files = Array.from({ length: 4096 }, (_, n) => ({ ...v.files[0], path: "/stdlib/" + String(n).padStart(5, "0"), origin: "stdlib" }));
    expect(parse(v).files).toHaveLength(4096); v.files.push({ ...v.files[0], path: "/stdlib/99999" }); expect(() => parse(v)).toThrow();
  });
  it.each([false, true])("accepts exact byte cap and refuses next byte (multibyte=%s)", (multibyte) => {
    const v = inventory(); v.files = [{ ...v.files[0], path: "/stdlib/" + (multibyte ? "é" : "a"), origin: "stdlib" }];
    const short = Buffer.byteLength(canonical(v)); v.files[0].path += "x".repeat(INVENTORY_LIMITS.object - short);
    const bytes = encoded(v); expect(bytes.length).toBe(INVENTORY_LIMITS.file); expect(parseApplicationInventory(bytes, binding(bytes)).files).toHaveLength(1);
    const tooLong = Buffer.from(canonical(v).replace('"path":"/stdlib/', '"path":"/stdlib/x') + "\n");
    expect(tooLong.length).toBe(INVENTORY_LIMITS.file + 1); expect(() => parseApplicationInventory(tooLong, binding(tooLong))).toThrow();
  });
  it("refuses UTF-16 order for U+E000 / U+10000", () => {
    const v = inventory(); v.files = ["\ue000", "\u{10000}"].map((p) => ({ ...v.files[0], path: "/stdlib/" + p, origin: "stdlib" }));
    expect(parse(v).files).toHaveLength(2); v.files.sort((a, b) => a.path < b.path ? -1 : 1); expect(() => parse(v)).toThrow("order");
  });
  it.each(["releaseRoot", "engineSha", "inventoryHash", "configPath"])("refuses wrong binding %s", (key) => {
    const expected = binding(valid); Object.assign(expected, { [key]: key === "configPath" ? root + "/" + INVENTORY_SIDECAR : key === "releaseRoot" ? "/elsewhere" : "a".repeat(key === "engineSha" ? 40 : 64) });
    expect(() => parseApplicationInventory(valid, expected)).toThrow();
  });
});

function harness() {
  const v = inventory(); const invBytes = encoded(v); const c = configValue(); c.application_inventory_sha256 = binding(invBytes).inventoryHash;
  const configBytes = line(c, LIMITS.config);
  const bytes = new Map([...contents, [configPath, configBytes], [root + "/" + INVENTORY_SIDECAR, invBytes]]);
  const meta = (path: string, size: number, kind: "file" | "directory") => ({ dev: 1, ino: parseInt(digest(Buffer.from(path)).slice(0, 10), 16), size, links: kind === "file" ? 1 : 2, kind, uid: 0, gid: 0, mode: kind === "file" ? 0o444 : 0o755, mtimeNs: "1", ctimeNs: "1", aclEvaluated: true as const, aclMutation: false as const, noSymlinkTraversal: true as const });
  const read = vi.fn(async (path: string, limit: number): Promise<ProtectedInventoryRead> => {
    const b = bytes.get(path); if (!b) throw new Error("missing"); if (b.length > limit) throw new Error("overflow");
    const parts = path.slice(1).split("/"); parts.pop();
    const snapshot = { descriptor: meta(path, b.length, "file"), pathname: meta(path, b.length, "file"), ancestors: ["/", ...parts.map((_, n) => "/" + parts.slice(0, n + 1).join("/"))].map((p) => ({ path: p, metadata: meta(p, 0, "directory") })) };
    return { bytes: b, before: snapshot, after: structuredClone(snapshot) };
  });
  const dependencies: InventoryDependencies = { read, serviceIdentity: vi.fn(async () => ({ uid: 501, groups: [20, 80], verified: true })), closure: vi.fn(async () => ({ files: v.files.map(({ path, origin }) => ({ path, origin })), builtins: [{ module: "sys", image: "/runtime/framework" }], complete: true, operationClosure: true, supportedImageStorage: true })) };
  const expected: InventoryIntakeBinding = { releaseRoot: root, packageRoot: root, python: "/runtime/python", configPath, configHash: digest(configBytes), engineSha: v.engine_sha };
  return { expected, dependencies, read, bytes };
}

describe("synthetic verifier intake; no actual H or OS qualification", () => {
  it("binds separate config, fixed sidecar, interpreter, stdlib and native bytes", async () => {
    const h = harness(); const result = await intakeApplicationInventory(h.expected, h.dependencies);
    expect(result.inventoryPath).toBe(root + "/" + INVENTORY_SIDECAR); expect(Object.isFrozen(result.config.catalog)).toBe(true);
    expect(h.read.mock.calls.filter(([p]) => p === configPath)).toHaveLength(2);
    expect(h.read.mock.calls).toContainEqual([root + "/" + INVENTORY_SIDECAR, 1048577]);
    expect(h.read.mock.calls).toContainEqual([configPath, 131072]);
    for (const [p, b] of contents) expect(h.read.mock.calls).toContainEqual([p, b.length]);
  });
  it("refuses missing real implementation by default", async () => { await expect(intakeApplicationInventory(harness().expected)).rejects.toThrow("unavailable"); });
  it.each(["packageRoot", "releaseRoot", "python", "configHash", "engineSha"])("refuses wrong parent pin %s", async (key) => {
    const h = harness(); Object.assign(h.expected, { [key]: key.endsWith("Hash") ? "a".repeat(64) : key === "engineSha" ? "a".repeat(40) : "/different" });
    await expect(intakeApplicationInventory(h.expected, h.dependencies)).rejects.toThrow();
  });
  it.each(["/runtime/stdlib.py", "/runtime/sqlite.so", "/runtime/python", configPath, root + "/" + INVENTORY_SIDECAR])("refuses missing or changed %s", async (path) => {
    const h = harness(); h.bytes.delete(path); await expect(intakeApplicationInventory(h.expected, h.dependencies)).rejects.toThrow();
    const changed = harness(); const b = Buffer.from(changed.bytes.get(path)!); b[0] ^= 1; changed.bytes.set(path, b);
    await expect(intakeApplicationInventory(changed.expected, changed.dependencies)).rejects.toThrow();
  });
  it.each(["missing", "extra", "duplicate", "origin", "builtin", "incomplete", "lazy", "storage"])("refuses closure proof defect %s", async (kind) => {
    const h = harness(); const closure = await h.dependencies.closure();
    if (kind === "missing") closure.files.pop(); if (kind === "extra") closure.files.push({ path: "/unlisted/image", origin: "native" });
    if (kind === "duplicate") closure.files.push(closure.files[0]); if (kind === "origin") closure.files[0].origin = "stdlib";
    if (kind === "builtin") closure.builtins[0].image = "/unaccounted/cache";
    if (kind === "incomplete") Object.assign(closure, { complete: false }); if (kind === "lazy") Object.assign(closure, { operationClosure: false });
    if (kind === "storage") Object.assign(closure, { supportedImageStorage: false });
    h.dependencies.closure = async () => closure; await expect(intakeApplicationInventory(h.expected, h.dependencies)).rejects.toThrow();
  });
  it.each(["root-service", "unknown", "duplicate-group"])("refuses identity %s", async (kind) => {
    const h = harness(); h.dependencies.serviceIdentity = async () => Object.assign({ uid: 501, groups: [20, 80], verified: true as const }, kind === "root-service" ? { uid: 0 } : kind === "unknown" ? { verified: false } : { groups: [20, 20] });
    await expect(intakeApplicationInventory(h.expected, h.dependencies)).rejects.toThrow();
  });
  it.each(["file-owner", "ancestor-owner", "group-write", "other-write", "acl", "unknown-acl", "symlink", "hardlink", "directory", "size", "replaced-descriptor", "replaced-path", "mtime", "ancestor-gap", "ancestor-order", "ancestor-changed", "overflow", "same-bytes-replacement"])("refuses read/protection defect %s", async (kind) => {
    const h = harness(); const original = h.dependencies.read; let configReads = 0;
    h.dependencies.read = async (path, limit) => {
      const r = await original(path, limit);
      if (path !== configPath) return r;
      configReads++;
      if (kind === "overflow") r.bytes = Buffer.alloc(limit + 1);
      if (kind === "file-owner") r.before.descriptor.uid = 501;
      if (kind === "ancestor-owner") r.before.ancestors.at(-1)!.metadata.uid = 501;
      if (kind === "group-write") Object.assign(r.before.descriptor, { gid: 80, mode: 0o464 });
      if (kind === "other-write") r.before.descriptor.mode = 0o446;
      if (kind === "acl") Object.assign(r.before.descriptor, { aclMutation: true });
      if (kind === "unknown-acl") Object.assign(r.before.descriptor, { aclEvaluated: false });
      if (kind === "symlink") Object.assign(r.before.descriptor, { noSymlinkTraversal: false });
      if (kind === "hardlink") r.before.descriptor.links = 2;
      if (kind === "directory") r.before.descriptor.kind = "directory";
      if (kind === "size") r.before.descriptor.size++;
      if (kind === "ancestor-gap") r.before.ancestors.shift();
      if (kind === "ancestor-order") r.before.ancestors.reverse();
      if (kind === "same-bytes-replacement" && configReads === 2) r.before.descriptor.ino++;
      r.before.pathname = structuredClone(r.before.descriptor); r.after = structuredClone(r.before);
      if (kind === "replaced-descriptor") r.after.descriptor.ino++;
      if (kind === "replaced-path") r.after.pathname.ino++;
      if (kind === "mtime") r.after.descriptor.mtimeNs = "2";
      if (kind === "ancestor-changed") r.after.ancestors[0].metadata.ino++;
      return r;
    };
    await expect(intakeApplicationInventory(h.expected, h.dependencies)).rejects.toThrow();
  });
  it("refuses dependency failures and does not retry", async () => {
    const h = harness(); h.dependencies.read = vi.fn().mockRejectedValue(new Error("unknown"));
    await expect(intakeApplicationInventory(h.expected, h.dependencies)).rejects.toThrow("unknown"); expect(h.dependencies.read).toHaveBeenCalledTimes(1);
  });
});
