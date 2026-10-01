/** Local service identity proof. Contains public file/process identity only. */
import { existsSync } from "node:fs";
import { lstat, realpath, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { artifactAppDir } from "./artifact-root";
import { loadedArtifactSha256, verifiedArtifact } from "./artifact";
import { canonical, quarterState, QuarterRefused, type QuarterDb } from "./schema";
import { assertSyntheticDatabase } from "./test-boundary";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const contractSchema = z.strictObject({ version: z.literal(1), nonce: z.uuid(), app: z.string(), database: z.string(),
  databaseIdentity: z.strictObject({ device: z.number().int(), inode: z.number().int() }),
  artifactSha256: hash, profileSha256: hash });

function refuse(): never { throw new QuarterRefused("SERVICE_STARTUP_IDENTITY_MISMATCH", 503); }
async function regular(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(file) !== file) refuse();
  return stat;
}

export async function attestServiceStartup(db: QuarterDb, compatible: () => Promise<void>) {
  const app = artifactAppDir(), directory = path.join(app, "var/run");
  const file = path.join(directory, "quarter-start-contract.json");
  const manifest = loadedArtifactSha256 ? verifiedArtifact() : null;
  if (!existsSync(file)) {
    // Unmanaged development fixtures remain confined to the positive disposable guard.
    if (!process.env.FLOOR_BOARDS_TEST_ROOT) refuse();
    await assertSyntheticDatabase(db); await compatible(); return;
  }
  if (await realpath(directory) !== directory) refuse();
  const contractStat = await regular(file);
  const contract = contractSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (!manifest || contract.app !== app || contract.artifactSha256 !== loadedArtifactSha256 || manifest.scope !== "runtime") refuse();
  // Next has loaded its configured environment; reject a different configured file
  // before asking Prisma to open it. Never include environment values in an error.
  if (process.env.DATABASE_URL !== "file:" + contract.database) refuse();
  const before = await regular(contract.database);
  if (before.dev !== contract.databaseIdentity.device || before.ino !== contract.databaseIdentity.inode) refuse();
  const databases = await db.$queryRawUnsafe<{ name: string; file: string }[]>("PRAGMA database_list");
  if (databases.find(value => value.name === "main")?.file !== contract.database) refuse();
  await compatible();
  const state = await quarterState(db), after = await regular(contract.database), finalContract = await regular(file);
  if (!state || before.dev !== after.dev || before.ino !== after.ino || finalContract.ino !== contractStat.ino || await readFile(file, "utf8") !== canonical(contract) + "\n") refuse();
  const receipt = { version: 1, nonce: contract.nonce, pid: process.pid, app, profileSha256: contract.profileSha256,
    artifactSha256: loadedArtifactSha256, database: contract.database, databaseIdentity: contract.databaseIdentity,
    databaseEpoch: state.databaseEpoch, schemaFingerprint: manifest.schemaSha256 };
  const temporary = path.join(directory, `quarter-start-receipt.${process.pid}.tmp`);
  await writeFile(temporary, canonical(receipt) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, path.join(directory, "quarter-start-receipt.json"));
}
