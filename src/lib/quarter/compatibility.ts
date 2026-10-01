import { assertSyntheticDatabase } from "./test-boundary";
import { QuarterRefused, quarterState, verifyQuarterSchema, type QuarterDb } from "./schema";

/** This artifact is a foundation, not R0. Active-state execution is confined to isolated proofs. */
export async function assertArtifactCompatibility(db:QuarterDb):Promise<void> {
  const state=await quarterState(db);
  if(!state)return;
  await verifyQuarterSchema(db);
  if(state.phase!=="active")return;
  if(!process.env.FLOOR_BOARDS_TEST_ROOT)throw new QuarterRefused("FOUNDATION_NOT_RECOVERY_ARTIFACT",503);
  await assertSyntheticDatabase(db);
}
export async function refuseSchemaPush(db:QuarterDb):Promise<void> {
  if(await quarterState(db))throw new QuarterRefused("QUARTER_EXPLICIT_MIGRATION_REQUIRED",503);
}
