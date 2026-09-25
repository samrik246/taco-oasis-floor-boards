/**
 * Shared release lock (B2 + onsite installer, Rich 2A / Elliot's bar, 25 Sep
 * 2026). The scheduled pull (`scripts/wiw-export.ts`) and the onsite
 * installer each hold this one file, at a path outside every directory the
 * installer extracts, replaces, or restores, while they run.
 *
 * Claiming is `open(file, "wx")`: atomic exclusive create, so two processes
 * racing for a free lock cannot both win. The file holds the holder's PID.
 * A hold ends the moment the holding process is gone -- exit, an uncaught
 * error, or a kill -- because the next attempt checks that PID with
 * `kill(pid, 0)` before waiting for it: a dead PID makes the file stale and
 * it is reclaimed immediately, no wait. This is process-liveness locking
 * (the mechanism behind the classic Unix `shlock`), not the `flock(2)`
 * syscall, but it gives the same observable guarantee: the lock frees
 * itself when its holder is gone, with no separate cleanup step required.
 *
 * `release` only removes the file if it still names the caller's own PID
 * (compare-and-delete), so a run can never delete a lock a later run has
 * since claimed.
 */
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export const RELEASE_LOCK_FILE_NAME = ".taco-oasis-floor-boards-release.lock";

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
};

async function defaultIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process, the lock is stale. Any other error (e.g.
    // EPERM, a live process this user cannot signal) means it is not.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readHolderPid(file: string): Promise<number | null> {
  try {
    const text = (await readFile(file, "utf8")).trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function tryClaim(file: string, pid: number): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(String(pid));
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

const DEFAULT_POLL_MS = 2000;

/**
 * Claim the lock for `pid`. A stale lock (its holder is no longer alive) is
 * reclaimed immediately, no wait. A live holder is polled for every
 * `pollMs`. With no `waitMs`, this waits as long as it takes. With a
 * `waitMs`, it gives up and returns `false` once that much time has passed
 * against a still-live holder; nothing is written to the lock file in that
 * case, so the caller is free to make no change at all.
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
  const file = releaseLockPathFor(appDir);
  const deadline = waitMs === undefined ? Number.POSITIVE_INFINITY : now().getTime() + waitMs;
  for (;;) {
    if (await tryClaim(file, pid)) return true;
    const holder = await readHolderPid(file);
    if (holder === null || !(await isAlive(holder))) {
      await rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    if (now().getTime() >= deadline) return false;
    await sleep(pollMs);
  }
}

/** Release the lock only if `pid` still holds it (compare-and-delete). */
export async function releaseReleaseLock(appDir: string, pid: number): Promise<void> {
  const file = releaseLockPathFor(appDir);
  try {
    if ((await readHolderPid(file)) === pid) await rm(file, { force: true });
  } catch {
    // Best-effort: a release that cannot run (or cannot remove the file)
    // still self-heals, because the next acquire checks this PID's
    // liveness before it ever waits on it.
  }
}
