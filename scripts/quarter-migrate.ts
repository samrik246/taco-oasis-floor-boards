import { prisma } from "../src/lib/db";
import { withReleaseLease } from "../src/lib/quarter/lease";
import { migrateQuarterStorage } from "../src/lib/quarter/schema";
// Explicit additive prepared migration only. No activation, server start, copy or rollback.
withReleaseLease(()=>migrateQuarterStorage(prisma)).then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error instanceof Error?error.message:"QUARTER_MIGRATION_FAILED");process.exitCode=1;})
  .finally(()=>prisma.$disconnect());
