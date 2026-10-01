import path from "node:path";
import { realpath } from "node:fs/promises";
import { QuarterRefused, quarterState, verifyQuarterSchema, type QuarterDb } from "./schema";

/** This artifact is a foundation, not R0. Active-state execution is confined to isolated proofs. */
export async function assertArtifactCompatibility(db:QuarterDb):Promise<void> {
  const state=await quarterState(db);
  if(!state)return;
  await verifyQuarterSchema(db);
  if(state.phase!=="active")return;
  const root=process.env.FLOOR_BOARDS_TEST_ROOT;
  if(!root)throw new QuarterRefused("FOUNDATION_NOT_RECOVERY_ARTIFACT",503);
  const databases=await db.$queryRawUnsafe<{name:string;file:string}[]>("PRAGMA database_list");
  const file=databases.find(d=>d.name==="main")?.file;
  if(!file)throw new QuarterRefused("SYNTHETIC_DATABASE_REQUIRED",503);
  const relative=path.relative(await realpath(root),await realpath(file));
  if(relative.startsWith("..")||path.isAbsolute(relative)||relative==="")throw new QuarterRefused("SYNTHETIC_DATABASE_REQUIRED",503);
}
export async function refuseSchemaPush(db:QuarterDb):Promise<void> {
  if(await quarterState(db))throw new QuarterRefused("QUARTER_EXPLICIT_MIGRATION_REQUIRED",503);
}
