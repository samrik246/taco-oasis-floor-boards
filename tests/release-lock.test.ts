/**
 * The shared release lock (B2 + onsite installer, Rich 2A / Elliot's bar,
 * 25 Sep 2026): the pull run and the onsite installer each hold this one
 * lock while they run. Covers the four points from Elliot's judged bar
 * (25 Sep, channel c78f4988): a second starter waits for a live holder;
 * the lock frees the moment its holder is gone; a capped wait against a
 * still-live holder gives up with nothing written; and a waiting run
 * proceeds once the holder releases. Also covers the review findings on
 * c41d140f (c9ab3fa7 / 480224fa): a claim is never ownerless while being
 * made, a stale claim's removal can never remove a newer live claim, and
 * the pull retries a lock failure instead of running unlocked.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireReleaseLock,
  acquireReleaseLockForPull,
  releaseLockPathFor,
  releaseReleaseLock,
} from "@/lib/release-lock";

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function tempAppDir(): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), "release-lock-"));
  return path.join(root, "app");
}

/** PIDs named by the claims now in the lock directory, sorted. */
async function claimPids(appDir: string): Promise<number[]> {
  const names = await readdir(releaseLockPathFor(appDir)).catch(() => [] as string[]);
  return names.map((n) => Number(n.split(".")[0])).sort((a, b) => a - b);
}

describe("release lock", () => {
  it("claims a free lock immediately outside the app directory, no wait", async () => {
    const appDir = await tempAppDir();
    const sleeps: number[] = [];
    const ok = await acquireReleaseLock(appDir, 111, { sleep: async (ms) => void sleeps.push(ms) });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([]);
    expect(await claimPids(appDir)).toEqual([111]);
    expect(releaseLockPathFor(appDir)).toBe(path.join(root, ".taco-oasis-floor-boards-release.lock"));
  });

  it("a second starter waits while the holder is live, then claims it once the holder is gone", async () => {
    const appDir = await tempAppDir();
    expect(await acquireReleaseLock(appDir, 1, { now: () => new Date(0) })).toBe(true);
    let alive = true;
    let polls = 0;
    const ok = await acquireReleaseLock(appDir, 2, {
      isAlive: async (pid) => pid === 1 && alive,
      sleep: async () => {
        polls += 1;
        if (polls === 2) alive = false; // the holder (pid 1) exits between polls
      },
    });
    expect(ok).toBe(true);
    expect(polls).toBe(2);
    expect(await claimPids(appDir)).toEqual([2]);
  });

  it("frees the lock immediately the instant its holder is no longer alive -- no wait for a dead PID", async () => {
    const appDir = await tempAppDir();
    expect(await acquireReleaseLock(appDir, 1, { isAlive: async () => true })).toBe(true);
    const sleeps: number[] = [];
    const ok = await acquireReleaseLock(appDir, 2, {
      isAlive: async () => false, // pid 1 is gone
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([]); // reclaimed a stale lock without waiting
    expect(await claimPids(appDir)).toEqual([2]);
  });

  it("a capped wait against a still-live holder gives up and leaves no claim of its own behind", async () => {
    const appDir = await tempAppDir();
    expect(await acquireReleaseLock(appDir, 1, { now: () => new Date(0) })).toBe(true);
    let tick = 0;
    const ok = await acquireReleaseLock(
      appDir,
      2,
      { isAlive: async () => true, now: () => new Date(tick), sleep: async () => void (tick += 60_000) },
      180_000,
    );
    expect(ok).toBe(false);
    expect(await claimPids(appDir)).toEqual([1]); // untouched: the original holder still owns it
  });

  it("releases only the caller's own claims", async () => {
    const appDir = await tempAppDir();
    await acquireReleaseLock(appDir, 1);
    await releaseReleaseLock(appDir, 2); // not the owner
    expect(await claimPids(appDir)).toEqual([1]);
    await releaseReleaseLock(appDir, 1);
    expect(await claimPids(appDir)).toEqual([]);
  });

  it("a waiting run proceeds as soon as the holder releases cleanly", async () => {
    const appDir = await tempAppDir();
    await acquireReleaseLock(appDir, 1);
    let released = false;
    const ok = await acquireReleaseLock(appDir, 2, {
      isAlive: async () => !released,
      sleep: async () => {
        released = true;
        await releaseReleaseLock(appDir, 1);
      },
    });
    expect(ok).toBe(true);
    expect(await claimPids(appDir)).toEqual([2]);
  });

  it("a claim being made is already owned: a second starter cannot take the lock in that window", async () => {
    // c9ab3fa7: the old lock file existed empty between create and write,
    // and a second starter treated it as stale. Here the first starter is
    // paused right after its claim exists, before it lists the directory.
    const appDir = await tempAppDir();
    let resumeFirst!: () => void;
    let firstPaused!: () => void;
    const paused = new Promise<void>((resolve) => (firstPaused = resolve));
    const first = acquireReleaseLock(appDir, 1, {
      isAlive: async () => true,
      afterClaimCreated: () =>
        new Promise<void>((resolve) => {
          resumeFirst = resolve;
          firstPaused();
        }),
    });
    await paused;
    expect(await claimPids(appDir)).toEqual([1]);
    let tick = 0;
    const second = await acquireReleaseLock(
      appDir,
      2,
      { isAlive: async () => true, now: () => new Date(tick), sleep: async () => void (tick += 1000) },
      3000,
    );
    expect(second).toBe(false);
    resumeFirst();
    expect(await first).toBe(true);
    expect(await claimPids(appDir)).toEqual([1]);
  });

  it("two starters both reclaiming the same dead holder cannot both win (480224fa)", async () => {
    // Both starters are paused after making their claims, with the dead
    // holder's claim still present; then both proceed. At most one holds.
    const appDir = await tempAppDir();
    const dir = releaseLockPathFor(appDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "9.deadbeef"), "");
    const isAlive = async (pid: number) => pid !== 9;
    const gates: (() => void)[] = [];
    let arrived = 0;
    let allArrived!: () => void;
    const bothPaused = new Promise<void>((resolve) => (allArrived = resolve));
    const pauseOnce = () => {
      let used = false;
      return () =>
        used
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              used = true;
              gates.push(resolve);
              if (++arrived === 2) allArrived();
            });
    };
    let tick = 0;
    const deps = () => ({
      isAlive,
      afterClaimCreated: pauseOnce(),
      now: () => new Date(tick),
      sleep: async () => void (tick += 1000),
    });
    const a = acquireReleaseLock(appDir, 1, deps(), 0);
    const b = acquireReleaseLock(appDir, 2, deps(), 0);
    await bothPaused;
    gates.forEach((g) => g());
    const results = await Promise.all([a, b]);
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(await claimPids(appDir)).not.toContain(9);
    const holders = await claimPids(appDir);
    expect(holders.length).toBe(results.filter(Boolean).length);
    // Whatever the outcome, nothing is left wedged: the next starter gets in.
    await releaseReleaseLock(appDir, 1);
    await releaseReleaseLock(appDir, 2);
    expect(await acquireReleaseLock(appDir, 3, { isAlive })).toBe(true);
  });

  it("removing a stale claim by name never removes a newer live claim", async () => {
    // The old reclaim read a dead PID, then unlinked the shared path -- which
    // by then could be another starter's fresh lock. A stale claim here is
    // removed by its own unique name.
    const appDir = await tempAppDir();
    const dir = releaseLockPathFor(appDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "9.deadbeef"), "");
    expect(await acquireReleaseLock(appDir, 1, { isAlive: async (pid) => pid !== 9 })).toBe(true);
    await rm(path.join(dir, "9.deadbeef"), { force: true }); // a late reclaimer acting on its stale read
    expect(await claimPids(appDir)).toEqual([1]);
  });

  it("ignores stray entries in the lock directory", async () => {
    const appDir = await tempAppDir();
    const dir = releaseLockPathFor(appDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".DS_Store"), "x");
    expect(await acquireReleaseLock(appDir, 1)).toBe(true);
  });

  it("a real lock-directory failure is not swallowed: it throws rather than silently granting the lock", async () => {
    // An installer must stop, not proceed unprotected, if the lock itself is
    // broken -- it is about to change the app tree, the database, and the
    // server.
    const appDir = path.join("/does-not-exist-release-lock-test", "app");
    await expect(acquireReleaseLock(appDir, 1)).rejects.toThrow();
    await expect(releaseReleaseLock(appDir, 1)).resolves.toBeUndefined();
  });

  it("the pull retries a lock failure and never returns before it holds the lock", async () => {
    const appDir = await tempAppDir();
    const errors: string[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    await acquireReleaseLockForPull(appDir, 5, {
      retryMs: 30_000,
      deps: { sleep: async (ms) => void sleeps.push(ms) },
      onError: (err) => errors.push((err as Error).message),
      acquire: async (dir, pid, deps) => {
        calls += 1;
        if (calls <= 2) throw new Error(`EACCES ${calls}`);
        return acquireReleaseLock(dir, pid, deps);
      },
    });
    expect(errors).toEqual(["EACCES 1", "EACCES 2"]);
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(await claimPids(appDir)).toEqual([5]);
  });
});
