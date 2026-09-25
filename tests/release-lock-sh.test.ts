/**
 * scripts/release-lock.sh against the same file, same format, same
 * algorithm as tests/release-lock.test.ts's TS side (Rich 2A / Elliot's
 * bar, 25 Sep 2026) -- an installer runs as a shell script, so this is
 * the half of the shared lock any installer actually sources. Real
 * processes, real `kill -0`, real wall-clock waits (kept short).
 *
 * Waits on each child's `exit` event, not `close`: a script that forks a
 * subshell from an EXIT trap (as `release_release_lock` does) can leave a
 * duplicate stdio file descriptor alive a beat longer than the process
 * itself, which delays `close` without affecting whether the process --
 * and the work it did to the lock file -- has actually finished.
 */
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "release-lock.sh");

async function tempAppDir(): Promise<{ root: string; appDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "release-lock-sh-"));
  const appDir = path.join(root, "app");
  return { root, appDir };
}

function lockFile(root: string): string {
  return path.join(root, ".taco-oasis-floor-boards-release.lock");
}

/** Runs bash `script` with SCRIPT sourced and APP_DIR set; waits for exit. */
function run(script: string, appDir: string, timeoutMs = 15_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", `set -euo pipefail; source "${SCRIPT}"; APP_DIR="${appDir}"; ${script}`]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: ${out}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** Spawns a background holder that claims the lock, then holds it for `holdSeconds`. */
function spawnHolder(appDir: string, holdSeconds: number) {
  const child = spawn("bash", [
    "-c",
    `set -euo pipefail; source "${SCRIPT}"; acquire_release_lock "${appDir}" && echo held; trap 'release_release_lock "${appDir}"' EXIT; sleep ${holdSeconds}`,
  ]);
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return { child, exited };
}

describe("scripts/release-lock.sh", () => {
  it("claims a free lock at the sibling path, releases cleanly on exit via trap", async () => {
    const { root, appDir } = await tempAppDir();
    try {
      const { code } = await run(
        `acquire_release_lock "\${APP_DIR}" && echo acquired; trap 'release_release_lock "\${APP_DIR}"' EXIT`,
        appDir,
      );
      expect(code).toBe(0);
      await expect(readFile(lockFile(root), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "a second starter waits for a live holder, then claims it once released",
    async () => {
      const { root, appDir } = await tempAppDir();
      try {
        const { exited } = spawnHolder(appDir, 3);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const before = (await readFile(lockFile(root), "utf8")).trim();
        expect(Number(before)).toBeGreaterThan(0);

        const waiterStart = Date.now();
        const { code, out } = await run(`acquire_release_lock "\${APP_DIR}" 10 && echo waited-and-acquired`, appDir);
        const waitedMs = Date.now() - waiterStart;
        expect(code).toBe(0);
        expect(out).toContain("waited-and-acquired");
        expect(waitedMs).toBeGreaterThan(1000); // it genuinely waited, not an instant re-claim

        await exited;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("reclaims a stale lock (dead PID) immediately, no wait", async () => {
    const { root, appDir } = await tempAppDir();
    try {
      const dead = spawnSync("bash", ["-c", "echo $$"]).stdout.toString().trim(); // exited already
      await mkdir(appDir, { recursive: true });
      await writeFile(lockFile(root), dead);

      const start = Date.now();
      const { code } = await run(`acquire_release_lock "\${APP_DIR}" 10 && echo reclaimed`, appDir);
      const elapsedMs = Date.now() - start;
      expect(code).toBe(0);
      expect(elapsedMs).toBeLessThan(1500); // reclaimed on the first attempt, no 2s poll
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "a capped wait against a still-live holder gives up and leaves the lock file untouched",
    async () => {
      const { root, appDir } = await tempAppDir();
      try {
        const { child: holder, exited } = spawnHolder(appDir, 6);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const before = (await readFile(lockFile(root), "utf8")).trim();

        const { code, out } = await run(
          `if acquire_release_lock "\${APP_DIR}" 2; then echo unexpectedly-acquired; mkdir -p "\${APP_DIR}/CHANGED"; else echo gave-up-no-change; fi`,
          appDir,
        );
        expect(code).toBe(0);
        expect(out).toContain("gave-up-no-change");
        expect((await readFile(lockFile(root), "utf8")).trim()).toBe(before); // still the original holder's PID
        await expect(readFile(path.join(appDir, "CHANGED"), "utf8")).rejects.toThrow();

        holder.kill("SIGKILL");
        await exited;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
