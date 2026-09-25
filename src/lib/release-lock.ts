/**
 * Shared release lock (B2 + onsite installer, Rich 2A / Elliot's bar, 25 Sep
 * 2026). The scheduled pull (`scripts/wiw-export.ts`) and the onsite
 * installer each hold this one lock, at a path outside every directory the
 * installer extracts, replaces, or restores, while they run.
 *
 * The lock is a directory. Each attempt to claim it creates one claim file
 * inside it, named `<pid>.<nonce>`, then lists the directory: the attempt
 * holds the lock only if its own claim is the only claim there. Otherwise it
 * withdraws its claim and waits. Any two attempts each create before they
 * list, so whichever lists second sees the other's claim; two attempts can
 * never both see themselves alone. The claimant's identity is the file NAME,
 * written in the same atomic create as the file itself, so there is no
 * moment where a claim exists but its owner is unknown.
 *
 * A claim whose PID is no longer alive (`kill(pid, 0)`) is stale: any
 * attempt removes that exact claim file by name and tries again at once.
 * Every claim name is unique (the nonce), so removing a stale name can never
 * remove a live claim that happens to have been made in the meantime. The
 * lock frees itself when its holder is gone -- exit, an uncaught error, or a
 * kill -- with no separate cleanup step required. Release removes only the
 * caller's own claims.
 *
 * `scripts/release-lock.sh` implements this same algorithm, on this same
 * directory and claim-name format, for a shell installer.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const RELEASE_LOCK_FILE_NAME = ".taco-oasis-floor-boards-release.lock";

/** `<pid>.<nonce>`: a positive decimal PID, a dot, then letters/digits. */
const CLAIM_NAME = /^([1-9][0-9]*)\.([A-Za-z0-9]+)$/;

/**
 * Sibling of the app directory, never inside it: the installer extracts,
 * backs up, and restores only inside `appDir` itself, so a lock there could
 * be wiped out by the very operation it is meant to guard.
 */
export function releaseLockPathFor(appDir: string): string {
  return path.join(path.dirname(path.resolve(appDir)), RELEASE_LOCK_FILE_NAME);
}

export type ReleaseLockDeps = {
  /** Defaults to a real `kill(pid, 0)` liveness check. */
  isAlive?: (pid: number) => Promise<boolean>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Called after this attempt's claim file exists and before it lists the directory. Tests only. */
  afterClaimCreated?: () => Promise<void>;
};

async function defaultIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process, the claim is stale. Any other error (e.g.
    // EPERM, a live process this user cannot signal) means it is not.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Claim names currently in the lock directory, with their PIDs. Other entries are ignored. */
async function listClaims(dir: string): Promise<{ name: string; pid: number }[]> {
  const claims: { name: string; pid: number }[] = [];
  for (const name of await readdir(dir)) {
    const m = CLAIM_NAME.exec(name);
    if (m) claims.push({ name, pid: Number(m[1]) });
  }
  return claims;
}

async function removeClaim(dir: string, name: string): Promise<void> {
  await rm(path.join(dir, name), { force: true });
}

type Attempt = "held" | "busy" | "retry";

/**
 * One claim attempt. "held": this attempt's claim is the only one, the lock
 * is ours. "busy": another live claim exists; this attempt's claim has been
 * withdrawn. "retry": only stale claims were in the way; they were removed
 * and this attempt's claim withdrawn, so try again at once.
 */
async function attemptClaim(dir: string, pid: number, deps: ReleaseLockDeps, isAlive: (pid: number) => Promise<boolean>): Promise<Attempt> {
  await mkdir(dir, { recursive: true });
  const mine = `${pid}.${randomBytes(8).toString("hex")}`;
  await writeFile(path.join(dir, mine), "", { flag: "wx" });
  if (deps.afterClaimCreated) await deps.afterClaimCreated();
  let others: { name: string; pid: number }[];
  try {
    others = (await listClaims(dir)).filter((c) => c.name !== mine);
  } catch (err) {
    await removeClaim(dir, mine).catch(() => undefined);
    throw err;
  }
  if (others.length === 0) return "held";
  await removeClaim(dir, mine);
  let liveOther = false;
  for (const other of others) {
    if (await isAlive(other.pid)) liveOther = true;
    else await removeClaim(dir, other.name);
  }
  return liveOther ? "busy" : "retry";
}

const DEFAULT_POLL_MS = 2000;

/**
 * Claim the lock for `pid`. Stale claims (holder no longer alive) are removed
 * immediately, no wait. A live holder is polled for about every `pollMs`
 * (jittered, so two waiters do not keep colliding). With no `waitMs`, this
 * waits as long as it takes. With a `waitMs`, it gives up and returns `false`
 * once that much time has passed against a still-live holder; this
 * attempt's own claim is withdrawn first, so nothing it wrote remains and the
 * caller is free to make no change at all. A real filesystem failure (the
 * lock directory cannot be created or read) throws.
 */
export async function acquireReleaseLock(
  appDir: string,
  pid: number,
  deps: ReleaseLockDeps = {},
  waitMs?: number,
  pollMs = DEFAULT_POLL_MS,
): Promise<boolean> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dir = releaseLockPathFor(appDir);
  const deadline = waitMs === undefined ? Number.POSITIVE_INFINITY : now().getTime() + waitMs;
  for (;;) {
    const result = await attemptClaim(dir, pid, deps, isAlive);
    if (result === "held") return true;
    if (result === "retry") continue;
    if (now().getTime() >= deadline) return false;
    await sleep(Math.round(pollMs * (0.5 + Math.random())));
  }
}

/** Release every claim `pid` holds in the lock. Never touches another process's claim. */
export async function releaseReleaseLock(appDir: string, pid: number): Promise<void> {
  const dir = releaseLockPathFor(appDir);
  try {
    for (const claim of await listClaims(dir)) {
      if (claim.pid === pid) await removeClaim(dir, claim.name);
    }
  } catch {
    // Best-effort: a release that cannot run (or cannot remove the file)
    // still self-heals, because the next acquire checks this PID's
    // liveness before it ever waits on it.
  }
}

const DEFAULT_ERROR_RETRY_MS = 30_000;

/**
 * The scheduled pull's acquire: waits with no cap for a live holder, and on
 * a lock failure (an actual error creating or reading the lock, not a held
 * lock) logs it and retries after `retryMs` instead of running unlocked. The
 * pull never starts its browser or import without holding the lock, so it
 * cannot overlap an install; it runs as soon as the lock can be taken.
 */
export async function acquireReleaseLockForPull(
  appDir: string,
  pid: number,
  opts: { deps?: ReleaseLockDeps; onError?: (err: unknown) => void; retryMs?: number; acquire?: typeof acquireReleaseLock } = {},
): Promise<void> {
  const acquire = opts.acquire ?? acquireReleaseLock;
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      if (await acquire(appDir, pid, opts.deps ?? {})) return;
    } catch (err) {
      opts.onError?.(err);
    }
    await sleep(opts.retryMs ?? DEFAULT_ERROR_RETRY_MS);
  }
}
