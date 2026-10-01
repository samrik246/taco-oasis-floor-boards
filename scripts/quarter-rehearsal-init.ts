/** Called only by exclusive new-file rehearsal initialization. */
import {prisma} from "../src/lib/db";
import {assertSyntheticDatabase} from "../src/lib/quarter/test-boundary";
import {quarterState} from "../src/lib/quarter/schema";
import {hashManagerCode} from "../src/lib/managers/codes";
import {fromZonedTime} from "date-fns-tz";
import {z} from "zod";
import {MANDATORY_STATIONS_BY_BOARD} from "../src/lib/mandatory";
import {ALL_STATIONS} from "../src/lib/stations";
async function main(){
  const baseDate=z.iso.date().parse(process.argv[2]);
  await assertSyntheticDatabase(prisma);
  if(await quarterState(prisma)||await prisma.employee.count()||await prisma.manager.count()||await prisma.station.count())throw new Error("INIT_DATABASE_NOT_EMPTY");
  await prisma.$transaction(async tx=>{
    for(const station of ALL_STATIONS)await tx.station.create({data:station});
    await tx.manager.create({data:{id:"quarter-rehearsal-owner",name:"Synthetic Owner",role:"owner",codeHash:hashManagerCode("quarter-rehearsal-owner")}});
    await tx.staffBreakLock.create({data:{id:1}});
    for(let index=0;index<12;index++){
      const date=new Date(Date.parse(`${baseDate}T12:00:00.000Z`)+index*86400000).toISOString().slice(0,10),id=`quarter-rehearsal-${index}`;
      await tx.employee.create({data:{id,externalId:id,firstName:"Synthetic",lastName:String(index)}});
      const start=fromZonedTime(`${date}T09:00:00`,"America/Chicago"),end=fromZonedTime(`${date}T12:05:00`,"America/Chicago");
      await tx.shift.create({data:{id,employeeId:id,date,board:"caja",sourcePosition:"Caja",startAt:start,endAt:end}});
      await tx.assignment.create({data:{id,employeeId:id,shiftId:id,stationId:"yellow",hourStart:start,hourEnd:new Date(+start+3600000)}});
      const pickStart=fromZonedTime(`${date}T13:00:00`,"America/Chicago"),pickEnd=new Date(+pickStart+3600000);
      for(const stationId of MANDATORY_STATIONS_BY_BOARD.caja){
        const person=`${id}-picker-${stationId}`;
        await tx.employee.create({data:{id:person,externalId:person,firstName:"Picker",lastName:stationId}});
        await tx.shift.create({data:{id:person,employeeId:person,date,board:"caja",sourcePosition:"Caja",startAt:pickStart,endAt:pickEnd}});
        await tx.assignment.create({data:{id:person,employeeId:person,shiftId:person,stationId,hourStart:pickStart,hourEnd:pickEnd}});
      }
      for(const [suffix,minutes] of [["partial",5],["full",60]] as const){
        const person=`${id}-cover-${suffix}`;
        await tx.employee.create({data:{id:person,externalId:person,firstName:"Cover",lastName:suffix}});
        await tx.shift.create({data:{id:person,employeeId:person,date,board:"other",sourcePosition:"Synthetic auxiliary",startAt:pickStart,endAt:new Date(+pickStart+minutes*60000)}});
      }
      await tx.staffBreak.create({data:{id:`${id}-due`,employeeId:`${id}-picker-green1`,shiftId:`${id}-picker-green1`,board:"caja",date,startAt:pickStart,endAt:new Date(+pickStart+900000),status:"pending",actor:"staff"}});

    }
  });
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
