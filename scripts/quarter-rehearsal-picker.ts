/** Fixed-time picker against the same migrated synthetic file and loaded artifact. */
import {writeFileSync} from "node:fs";
import {prisma} from "../src/lib/db";
import {assertArtifactCompatibility} from "../src/lib/quarter/compatibility";
import {assertSyntheticDatabase} from "../src/lib/quarter/test-boundary";
import {pickDueCovers} from "../src/lib/breaks/auto-pick";
import {chicagoHourStart} from "../src/lib/hour-grid";
import {readQuarterDay} from "../src/lib/quarter/public";
const [date,source,output,mode]=process.argv.slice(2);
async function main(){
 await assertSyntheticDatabase(prisma);await assertArtifactCompatibility(prisma);
 const fixed=new Date(+chicagoHourStart(date,13)-300000);
 const first=await pickDueCovers(fixed,prisma),second=await pickDueCovers(fixed,prisma);
 if(second.picked||second.rolled||second.ended)throw new Error("PICKER_NOT_IDEMPOTENT");
 if(mode==="before"&&first.picked!==1)throw new Error("PICKER_DID_NOT_BOOK");
 if(mode==="after"&&(first.picked||first.rolled||first.ended))throw new Error("RECOVERY_REPICKED_BOOKING");
 const row=await prisma.staffBreak.findUniqueOrThrow({where:{id:`${source}-due`}});
 if(row.status!=="booked"||row.coverEmployeeId!==`${source}-cover-full`||row.coverShiftId!==`${source}-cover-full`)throw new Error("PICKER_SOURCE_OR_PARTIAL_WINDOW_MISMATCH");
 const day=await prisma.$transaction(tx=>readQuarterDay(tx,"caja",date));
 writeFileSync(output,JSON.stringify({fixedNow:fixed.toISOString(),first,second,booking:{id:row.id,status:row.status,employeeId:row.employeeId,shiftId:row.shiftId,coverEmployeeId:row.coverEmployeeId,coverShiftId:row.coverShiftId,startAt:row.startAt,endAt:row.endAt},coverDisplay:day.coverDisplay})+"\n");
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
