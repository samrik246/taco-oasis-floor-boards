import { loadedArtifactSha256, assertArtifactSchema, assertLoadedArtifactIdentity } from "./artifact";
import { assertSyntheticDatabase } from "./test-boundary";
import { QuarterRefused, quarterState, verifyQuarterSchema, type QuarterDb } from "./schema";

/** Real R0 execution requires its complete loaded artifact and schema pins.
 * Unsealed source fixtures remain confined to the established positive disposable guard. */
export async function assertArtifactCompatibility(db:QuarterDb):Promise<void> {
  const state=await quarterState(db);
  if(!state)return;
  await verifyQuarterSchema(db);
  assertLoadedArtifactIdentity();
  if(loadedArtifactSha256){await assertArtifactSchema(db);if(process.env.FLOOR_BOARDS_TEST_ROOT)await assertSyntheticDatabase(db);return;}
  if(state.phase!=="active")return;
  if(!process.env.FLOOR_BOARDS_TEST_ROOT)throw new QuarterRefused("FOUNDATION_NOT_RECOVERY_ARTIFACT",503);
  await assertSyntheticDatabase(db);
}
export async function refuseSchemaPush(db:QuarterDb):Promise<void> {
  if(await quarterState(db))throw new QuarterRefused("QUARTER_EXPLICIT_MIGRATION_REQUIRED",503);
}

export async function assertRuntimeCompatibility(db:QuarterDb):Promise<void>{
  await assertArtifactCompatibility(db);
  if(await quarterState(db))await assertArtifactSchema(db);
}
