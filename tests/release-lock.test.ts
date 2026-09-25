/**
 * The shared release lock (B2 + onsite installer, Rich 2A / Elliot's bar,
 * 25 Sep 2026): the pull run and the onsite installer each hold this one
 * file while they run. Covers the four points from Elliot's judged bar
 * (25 Sep, channel c78f4988): a second starter waits for a live holder;
 * the lock frees the moment its holder is gone; a capped wait against a
 * still-live holder gives up with nothing written; and a waiting run
 * proceeds once the holder releases.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireReleaseLock, releaseLockPathFor, releaseReleaseLock } from "@/lib/release-lock";

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function tempAppDir(): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), "release-lock-"));
  const appDir = path.join(root, "app");
  return appDir;
}

async function lockText(appDir: string): Promise<string> {
  return (await readFile(releaseLockPathFor(appDir), "utf8")).trim();
}

describe("release lock", () => {
  it("claims a free lock immediately outside the app directory, no wait", async () => {
    const appDir = await tempAppDir();
    const sleeps: number[] = [];
    const ok = await acquireReleaseLock(appDir, 111, { sleep: async (ms) => void sleeps.push(ms) });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([]);
    expect(await lockText(appDir)).toBe("111");
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
    expect(await lockText(appDir)).toBe("2");
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
    expect(await lockText(appDir)).toBe("2");
  });

  it("a capped wait against a still-live holder gives up and writes nothing", async () => {
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
    expect(await lockText(appDir)).toBe("1"); // untouched: the original holder still owns it
  });

  it("releases only when the caller still owns the lock (compare-and-delete)", async () => {
    const appDir = await tempAppDir();
    await acquireReleaseLock(appDir, 1);
    await releaseReleaseLock(appDir, 2); // not the owner
    expect(await lockText(appDir)).toBe("1");
    await releaseReleaseLock(appDir, 1);
    await expect(readFile(releaseLockPathFor(appDir), "utf8")).rejects.toThrow();
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
    expect(await lockText(appDir)).toBe("2");
  });

  it("a real lock-directory failure is not swallowed: it throws rather than silently granting the lock", async () => {
    // An installer must stop, not proceed unprotected, if the lock itself is
    // broken -- it is about to change the app tree, the database, and the
    // server. (The pull script's own caller is the one that must never skip
    // a run; it wraps this call and treats a throw as "proceed unlocked".)
    const appDir = path.join("/does-not-exist-release-lock-test", "app");
    await expect(acquireReleaseLock(appDir, 1)).rejects.toThrow();
    await expect(releaseReleaseLock(appDir, 1)).resolves.toBeUndefined();
  });
});
