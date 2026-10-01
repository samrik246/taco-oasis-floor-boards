/** Controlled synthetic picker/schema entry point; no activation or schema rewrite. */
import {prisma} from "../src/lib/db";
import {assertArtifactCompatibility} from "../src/lib/quarter/compatibility";
import {assertSyntheticDatabase} from "../src/lib/quarter/test-boundary";
import {captureQuarterPreservation} from "../src/lib/quarter/preservation";
import {pickDueCovers} from "../src/lib/breaks/auto-pick";
async function main(){
  await assertArtifactCompatibility(prisma);await assertSyntheticDatabase(prisma);
  const [action,instant]=process.argv.slice(2);
  if(action==="guard")console.log(JSON.stringify(await prisma.$transaction(tx=>captureQuarterPreservation(tx))));
  else if(action==="pick"&&instant&&Number.isFinite(Date.parse(instant)))console.log(JSON.stringify(await pickDueCovers(new Date(instant),prisma)));
  else throw new Error("Usage: quarter-control.ts guard | pick <fixed ISO instant>");
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
