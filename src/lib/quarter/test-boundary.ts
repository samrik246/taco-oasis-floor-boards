import { safeDatabasePath, safeOpenedDatabasePath } from "../../../scripts/test-db-path.cjs";
import { QuarterRefused, type QuarterDb } from "./schema";

export function syntheticDatabasePath():string {
  try { return safeDatabasePath(process.env); }
  catch { throw new QuarterRefused("SYNTHETIC_DATABASE_REQUIRED",503); }
}
export async function assertSyntheticDatabase(db:QuarterDb):Promise<void> {
  syntheticDatabasePath();
  const databases=await db.$queryRawUnsafe<{name:string;file:string}[]>("PRAGMA database_list");
  try { safeOpenedDatabasePath(databases.find(d=>d.name==="main")?.file,process.env); }
  catch { throw new QuarterRefused("SYNTHETIC_DATABASE_REQUIRED",503); }
}
