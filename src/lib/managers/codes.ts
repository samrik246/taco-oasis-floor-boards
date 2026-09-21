import { createHash, timingSafeEqual } from "node:crypto";

/** App-level salt — codes are never stored or shipped in plaintext. */
const CODE_SALT = "taco-oasis-manager-v1";

export function hashManagerCode(code: string): string {
  return createHash("sha256")
    .update(`${CODE_SALT}:${code.trim()}`)
    .digest("hex");
}

export function verifyManagerCodeHash(
  code: string,
  storedHash: string,
): boolean {
  const a = Buffer.from(hashManagerCode(code), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Demo managers for seed / docs.
 * Codes are hashed before insert — never expose plaintext via API.
 *
 * | Name | Demo code |
 * | ---- | --------- |
 * | Ana Rivera | 2468 |
 * | Luis Ortega | 1357 |
 * | Sam Chen | 8642 |
 */
export const DEMO_MANAGERS = [
  { name: "Ana Rivera", code: "2468" },
  { name: "Luis Ortega", code: "1357" },
  { name: "Sam Chen", code: "8642" },
] as const;

/** Default idle timeout before manager → staff (ms). Override with MANAGER_IDLE_MS. */
export const DEFAULT_MANAGER_IDLE_MS = 15_000;

export function managerIdleMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MANAGER_IDLE_MS;
  if (raw == null || raw === "") return DEFAULT_MANAGER_IDLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 100) return DEFAULT_MANAGER_IDLE_MS;
  return Math.floor(n);
}
