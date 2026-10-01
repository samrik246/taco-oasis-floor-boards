import { prisma } from "../db";
import { importerIdentity } from "../quarter/importer-identity";
import { quarterLeaseAppDir, withClaimedReleaseLease } from "../quarter/lease";
import { assertArtifactCompatibility } from "../quarter/compatibility";
import { acquireReleaseLockForPull, releaseReleaseLock } from "../release-lock";
import { runWiwExport, type WiwExportDeps, type WiwExportSettings } from "./run";

/** The timer and disposable provider rehearsal enter the same loaded-artifact boundary.
 * Constructing a provider is deliberately deferred until the waiting run owns the lease. */
export async function runScheduledExport(settings: WiwExportSettings, provider: () => WiwExportDeps | Promise<WiwExportDeps>) {
  const leaseAppDir = await quarterLeaseAppDir(prisma);
  const identity = await importerIdentity("hourly");
  try {
    // No wait cap: preserve the accepted timer's drain-after-release behavior.
    await acquireReleaseLockForPull(leaseAppDir, process.pid, {
      onError: error => console.error(`wiw-export lock error=${error instanceof Error ? error.message : "LOCK"} retrying`),
    });
    try {
      return await withClaimedReleaseLease(leaseAppDir, async () => {
        identity.check();
        await identity.state("running");
        await assertArtifactCompatibility(prisma);
        return runWiwExport(settings, await provider());
      });
    } finally {
      await releaseReleaseLock(leaseAppDir, process.pid);
    }
  } finally {
    await identity.close();
  }
}
