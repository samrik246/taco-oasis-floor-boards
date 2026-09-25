/**
 * scripts/release-lock.sh against the same directory, same claim-name
 * format, same algorithm as tests/release-lock.test.ts's TS side (Rich 2A /
 * Elliot's bar, 25 Sep 2026) -- an installer runs as a shell script, so this
 * is the half of the shared lock any installer actually sources. Real
 * processes, real `kill -0`, real wall-clock waits (kept short). The last
 * test runs shell and Node contenders against each other.
 *
 * Waits on each child's `exit` event, not `close`: a script that forks a
 * subshell from an EXIT trap (as `release_release_lock` does) can leave a
 * duplicate stdio file descriptor alive a beat longer than the process
 * itself, which delays `close` without affecting whether the process --
 * and the work it did to the lock -- has actually finished.
 */
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "release-lock.sh");
const CONTENDER = path.resolve(__dirname, "fixtures", "release-lock-contender.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

async function tempAppDir(): Promise<{ root: string; appDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "release-lock-sh-"));
  const appDir = path.join(root, "app");
  return { root, appDir };
}

function lockDir(root: string): string {
  return path.join(root, ".taco-oasis-floor-boards-release.lock");
}

async function claims(root: string): Promise<string[]> {
  return (await readdir(lockDir(root)).catch(() => [] as string[])).sort();
}

function deadPid(): string {
  return spawnSync("bash", ["-c", "echo $$"]).stdout.toString().trim(); // exited already
}

/** Runs bash `script` with SCRIPT sourced and APP_DIR set; waits for exit. */
function run(script: string, appDir: string, timeoutMs = 15_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", `set -euo pipefail; source "${SCRIPT}"; APP_DIR="${appDir}"; ${script}`], {
      env: { ...process.env, RELEASE_LOCK_POLL_MS: "200" },
    });
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
      const { code, out } = await run(
        `acquire_release_lock "\${APP_DIR}" && echo acquired; ls "$(release_lock_path "\${APP_DIR}")"; trap 'release_release_lock "\${APP_DIR}"' EXIT`,
        appDir,
      );
      expect(code).toBe(0);
      expect(out).toMatch(/acquired\n[1-9][0-9]*\.[0-9]+\n/);
      expect(await claims(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "a second starter waits for a live holder, then claims it once released",
    async () => {
      const { root, appDir } = await tempAppDir();
      try {
        const { child, exited } = spawnHolder(appDir, 3);
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(await claims(root)).toEqual([expect.stringMatching(new RegExp(`^${child.pid}\\.`))]);

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
      await mkdir(lockDir(root), { recursive: true });
      await writeFile(path.join(lockDir(root), `${deadPid()}.123`), "");

      const start = Date.now();
      const { code } = await run(`acquire_release_lock "\${APP_DIR}" 10 && echo reclaimed`, appDir);
      const elapsedMs = Date.now() - start;
      expect(code).toBe(0);
      expect(elapsedMs).toBeLessThan(1500); // reclaimed on the first attempt, no poll
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a live claim still being made blocks a shell starter (c9ab3fa7's window)", async () => {
    // A Node starter paused between making its claim and listing looks like
    // exactly this: a claim naming a live PID. The old empty lock file here
    // was treated as stale and taken.
    const { root, appDir } = await tempAppDir();
    try {
      await mkdir(lockDir(root), { recursive: true });
      const pending = `${process.pid}.abc123`;
      await writeFile(path.join(lockDir(root), pending), "");
      const { code, out } = await run(
        `if acquire_release_lock "\${APP_DIR}" 1; then echo unexpectedly-acquired; else echo blocked-rc=$?; fi`,
        appDir,
      );
      expect(code).toBe(0);
      expect(out).toContain("blocked-rc=1");
      expect(await claims(root)).toEqual([pending]); // gave up with its own claim withdrawn
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "a capped wait against a still-live holder gives up and leaves the lock untouched",
    async () => {
      const { root, appDir } = await tempAppDir();
      try {
        const { child: holder, exited } = spawnHolder(appDir, 6);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const before = await claims(root);

        const { code, out } = await run(
          `if acquire_release_lock "\${APP_DIR}" 2; then echo unexpectedly-acquired; mkdir -p "\${APP_DIR}/CHANGED"; else echo gave-up-no-change; fi`,
          appDir,
        );
        expect(code).toBe(0);
        expect(out).toContain("gave-up-no-change");
        expect(await claims(root)).toEqual(before); // still only the original holder's claim
        await expect(readdir(path.join(appDir, "CHANGED"))).rejects.toThrow();

        holder.kill("SIGKILL");
        await exited;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("release removes only this shell's own claims", async () => {
    const { root, appDir } = await tempAppDir();
    try {
      await mkdir(lockDir(root), { recursive: true });
      const other = `${process.pid}.999`;
      await writeFile(path.join(lockDir(root), other), "");
      const { code } = await run(
        `: > "$(release_lock_path "\${APP_DIR}")/$$.1"; release_release_lock "\${APP_DIR}"`,
        appDir,
      );
      expect(code).toBe(0);
      expect(await claims(root)).toEqual([other]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a real lock-directory failure returns 2, not success", async () => {
    const { root, appDir } = await tempAppDir();
    try {
      await writeFile(lockDir(root), "not a directory");
      const { code, out } = await run(
        `if acquire_release_lock "\${APP_DIR}" 1; then echo unexpectedly-acquired; else echo rc=$?; fi`,
        appDir,
      );
      expect(code).toBe(0);
      expect(out).toContain("rc=2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "shell and Node contenders, over dead holders' leftovers, are never inside at the same time",
    async () => {
      const { root, appDir } = await tempAppDir();
      const markerDir = path.join(root, "marker");
      await mkdir(markerDir, { recursive: true });
      await mkdir(lockDir(root), { recursive: true });
      for (let i = 0; i < 3; i++) await writeFile(path.join(lockDir(root), `${deadPid()}.${i}`), "");
      const rounds = 4;
      const shellRound = `acquire_release_lock "\${APP_DIR}"; if (set -o noclobber; : > "${markerDir}/inside") 2>/dev/null; then sleep 0.02; rm -f "${markerDir}/inside"; else echo overlap; fi; release_release_lock "\${APP_DIR}"`;
      const shellScript = `for i in $(seq ${rounds}); do ${shellRound}; done; echo done`;
      const node = (): Promise<{ code: number | null; out: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn(TSX, [CONTENDER, appDir, String(rounds), markerDir]);
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (out += d));
          child.on("error", reject);
          child.on("exit", (code) => resolve({ code, out }));
        });
      try {
        const results = await Promise.all([
          run(shellScript, appDir, 60_000),
          run(shellScript, appDir, 60_000),
          run(shellScript, appDir, 60_000),
          node(),
          node(),
          node(),
        ]);
        for (const r of results) {
          expect(r.code, r.out).toBe(0);
          expect(r.out).toContain("done");
          expect(r.out).not.toContain("overlap");
        }
        expect(await claims(root)).toEqual([]); // dead leftovers reclaimed, every claim released
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
