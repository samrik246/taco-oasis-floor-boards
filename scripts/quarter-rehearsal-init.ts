/** Called only by exclusive new-file rehearsal initialization. */
import {prisma} from "../src/lib/db";
import {assertSyntheticDatabase} from "../src/lib/quarter/test-boundary";
import {quarterState} from "../src/lib/quarter/schema";
import {hashManagerCode} from "../src/lib/managers/codes";
import {fromZonedTime} from "date-fns-tz";
import {ALL_STATIONS} from "../src/lib/stations";
async function main(){
  await assertSyntheticDatabase(prisma);
  if(await quarterState(prisma)||await prisma.employee.count()||await prisma.manager.count()||await prisma.station.count())throw new Error("INIT_DATABASE_NOT_EMPTY");
  await prisma.$transaction(async tx=>{
    for(const station of ALL_STATIONS)await tx.station.create({data:station});
    await tx.manager.create({data:{id:"quarter-rehearsal-owner",name:"Synthetic Owner",role:"owner",codeHash:hashManagerCode("quarter-rehearsal-owner")}});
    await tx.staffBreakLock.create({data:{id:1}});
    for(let index=0;index<12;index++){
      const date=new Date(Date.UTC(2040,9,10+index)).toISOString().slice(0,10),id=`quarter-rehearsal-${index}`;
      await tx.employee.create({data:{id,externalId:id,firstName:"Synthetic",lastName:String(index)}});
      const start=fromZonedTime(`${date}T09:00:00`,"America/Chicago"),end=fromZonedTime(`${date}T12:05:00`,"America/Chicago");
      await tx.shift.create({data:{id,employeeId:id,date,board:"caja",sourcePosition:"Caja",startAt:start,endAt:end}});
      await tx.assignment.create({data:{id,employeeId:id,shiftId:id,stationId:"yellow1",hourStart:start,hourEnd:new Date(+start+3600000)}});
    }
  });
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
