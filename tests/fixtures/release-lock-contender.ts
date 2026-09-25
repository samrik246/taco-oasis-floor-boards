/**
 * A Node contender for tests/release-lock-sh.test.ts's shell/Node contention
 * test: `tsx release-lock-contender.ts <app-dir> <rounds> <marker-dir>`.
 * Each round takes the release lock, proves nobody else is inside (an
 * exclusive create of one shared marker file), holds briefly, then leaves.
 * Prints "overlap" if it ever finds someone else inside.
 */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireReleaseLock, releaseReleaseLock } from "../../src/lib/release-lock";

async function main() {
  const [appDir, roundsText, markerDir] = process.argv.slice(2);
  const marker = path.join(markerDir, "inside");
  for (let i = 0; i < Number(roundsText); i++) {
    await acquireReleaseLock(appDir, process.pid, {}, undefined, 100);
    try {
      await writeFile(marker, String(process.pid), { flag: "wx" });
    } catch {
      console.log("overlap");
      await releaseReleaseLock(appDir, process.pid);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rm(marker, { force: true });
    await releaseReleaseLock(appDir, process.pid);
  }
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
