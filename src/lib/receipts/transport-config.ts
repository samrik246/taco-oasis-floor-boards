import { z } from "zod";
import { canonical, decodeLine, digest, hashSchema, LIMITS, safeInteger, sha1Schema } from "./transport-codec";

const absolute = z.string().min(1).refine((s) => s.startsWith("/") && !s.includes("\0") && !s.split("/").some((p) => p === "." || p === ".."));
const identity = z.tuple([safeInteger, safeInteger]);
const device = z.string().regex(/^receipt-[A-Za-z0-9_-]{1,40}$/);
const store = z.object({ root: absolute, root_identity: identity, files: z.object({ "receipt-engine.sqlite": identity, "store.lock": identity }).strict() }).strict();
const ownership = z.object({ root: absolute, root_identity: identity, device_root_identity: identity, devices: z.array(device).min(1).max(64), files: z.record(z.string(), identity) }).strict();
const catalog = z.object({ revision: safeInteger, devices: z.array(z.object({ device_id: device, profile_sha256: hashSchema.nullable(), identity_sha256: hashSchema.nullable(), commissioned_for_orders: z.boolean() }).strict()).min(1).max(64) }).strict();
const authority = z.object({ schema: z.literal("receipt-planning-authority/v1"), content_sha256: z.array(hashSchema).max(1024), profile_sha256: z.array(hashSchema).min(1).max(64), renderer_sha256: hashSchema }).strict();
const configSchema = z.object({ schema: z.literal("receipt-adapter-worker-config/v1"), engine_sha: sha1Schema, application_inventory_sha256: hashSchema, store_attestation: store, store_attestation_sha256: hashSchema, ownership_attestation: ownership, ownership_attestation_sha256: hashSchema, catalog, authority }).strict();
export type WorkerConfig = z.infer<typeof configSchema>;

/** Bytes and retained bindings only; this is NOT a filesystem/runtime H check. */
export function parseWorkerConfig(bytes: Uint8Array, expectedHash: string): WorkerConfig {
  hashSchema.parse(expectedHash);
  if (digest(bytes) !== expectedHash) throw new Error("config hash");
  const c = configSchema.parse(decodeLine(bytes, LIMITS.config));
  const devices = c.catalog.devices.map((d) => d.device_id).sort();
  if (new Set(devices).size !== devices.length || canonical(devices) !== canonical(c.ownership_attestation.devices)) throw new Error("catalog devices");
  if (c.catalog.devices.some((d) => d.commissioned_for_orders && (!d.profile_sha256 || !d.identity_sha256))) throw new Error("catalog profile");
  for (const values of [c.authority.content_sha256, c.authority.profile_sha256]) if (new Set(values).size !== values.length) throw new Error("authority duplicates");
  const expectedFiles = ["operation.lock", "control.lock", ...devices.map((d) => `device-locks/${d}.lock`)].sort();
  if (canonical(Object.keys(c.ownership_attestation.files).sort()) !== canonical(expectedFiles)) throw new Error("ownership files");
  if (c.store_attestation.root !== c.ownership_attestation.root || canonical(c.store_attestation.root_identity) !== canonical(c.ownership_attestation.root_identity)) throw new Error("root agreement");
  for (const kind of ["store", "ownership"] as const) {
    if (digest(Buffer.from(canonical(c[`${kind}_attestation`]))) !== c[`${kind}_attestation_sha256`]) throw new Error("inventory hash");
  }
  return c;
}
