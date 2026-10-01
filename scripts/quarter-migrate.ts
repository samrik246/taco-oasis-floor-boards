import { prisma } from "../src/lib/db";
import { withReleaseLease,withControllerReleaseLease } from "../src/lib/quarter/lease";
import { migrateQuarterStorage } from "../src/lib/quarter/schema";
// Explicit additive prepared migration only. No activation, server start, copy or rollback.
async function migrate(){
  const args=process.argv.slice(2);
  if(args.length===0)return withReleaseLease(()=>migrateQuarterStorage(prisma));
  if(args.length===2&&args[0]==="--controller-claim")return withControllerReleaseLease(args[1],()=>migrateQuarterStorage(prisma));
  throw new Error("INVALID_MIGRATION_ARGUMENTS");
}
migrate().then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error instanceof Error?error.message:"QUARTER_MIGRATION_FAILED");process.exitCode=1;})
  .finally(()=>prisma.$disconnect());
