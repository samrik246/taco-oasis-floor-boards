import { prisma } from "../src/lib/db";
import { refuseSchemaPush } from "../src/lib/quarter/compatibility";
refuseSchemaPush(prisma).catch(error=>{console.error(error instanceof Error?error.message:"QUARTER_SCHEMA_GUARD");process.exitCode=1;}).finally(()=>prisma.$disconnect());
