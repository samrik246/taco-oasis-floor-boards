/** Actual loaded-artifact picker cases. Each has its own preseeded date in one retained DB. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import {prisma} from "../src/lib/db";
import {assertArtifactCompatibility} from "../src/lib/quarter/compatibility";
import {assertSyntheticDatabase} from "../src/lib/quarter/test-boundary";
import {pickDueCovers,setAfterPickReadForTests} from "../src/lib/breaks/auto-pick";
import {assessBreak} from "../src/lib/breaks/rules";
import {paintV2,quarterWrite} from "../src/lib/quarter/transaction";
import {chicagoHourStart} from "../src/lib/hour-grid";
import {readQuarterDay} from "../src/lib/quarter/public";
import {decisionPaints} from "../src/lib/quarter/decision-paint";
import {buildDaySlices} from "../src/lib/slices/day-slices";
import {MANDATORY_STATIONS_BY_BOARD} from "../src/lib/mandatory";
import {loadOverlayRecords,toSliceOverlay} from "../src/lib/overlays/read";
import type {PaintIntent} from "../src/lib/quarter/protocol";

const [baseDate,mode,output,prior]=process.argv.slice(2);
const cases=["erased-quarter","mixed-destination","five-minute-tail","stale-requester","paint-race","source-race","overlay-race","time-boundaries","saved-cross-board","saved-shuffle","already-started"];
const zero={picked:0,rolled:0,ended:0};
async function main(){
 await assertSyntheticDatabase(prisma);await assertArtifactCompatibility(prisma);
 const results=[];
 for(let offset=0;offset<cases.length;offset++){
  const index=16+offset,id=`quarter-rehearsal-${index}`,requester=`${id}-picker-green1`,cover=`${id}-cover-full`;
  const date=new Date(Date.parse(`${baseDate}T12:00:00Z`)+index*86400000).toISOString().slice(0,10);
  const start=+chicagoHourStart(date,13),now=new Date(index===26?start:start-300000);
  const paint=async(intents:PaintIntent[])=>{
   const day=await prisma.$transaction(tx=>readQuarterDay(tx,"caja",date,now));
   const ids=new Set(intents.map(i=>i.shiftId));
   return paintV2({protocol:2,requestId:randomUUID(),capabilitySha256:day.capabilitySha256,board:"caja",date,
    expected:{databaseEpoch:day.databaseEpoch,worldRevision:day.worldRevision},sources:day.sources.filter(s=>ids.has(s.shiftId)),
    hours:day.hours.filter(h=>ids.has(h.shiftId)).map(h=>({shiftId:h.shiftId,hourStart:h.hourStart,revision:h.revision,...(h.revision===null?{legacySha256:h.legacySha256}:{})})),intents},
    {id:"rehearsal-picker",name:"Synthetic picker"},now,prisma);
  };
  if(mode==="before"){
   if(index===16)await paint([{shiftId:requester,quarter:"13:00",granularity:"quarter",action:"erase"}]);
   if(index===17){
    const sources=await prisma.shift.findMany({where:{id:requester}});
    assert.deepEqual(assessBreak({date,startAt:new Date(start+900000),endAt:new Date(start+2700000),shifts:sources,otherBreaks:[]}),{shiftId:requester,board:"caja"},"mixed-destination: valid rolled allowance required");
    await quarterWrite(prisma,tx=>tx.staffBreak.update({where:{id:`${id}-due`},data:{endAt:new Date(start+1800000)}}));
    await paint([{shiftId:requester,quarter:"13:15",granularity:"quarter",action:"station",stationId:"blue"}]);
   }
   if(index===18)await quarterWrite(prisma,tx=>tx.employeeStationAbility.create({data:{employeeId:cover,stationId:"green1",level:"forbidden"}}));
   if(index===20)setAfterPickReadForTests(async()=>{setAfterPickReadForTests(null);await paint([{shiftId:requester,quarter:"13:00",granularity:"quarter",action:"erase"}]);});
   if(index===21)setAfterPickReadForTests(async()=>{setAfterPickReadForTests(null);await quarterWrite(prisma,tx=>tx.shift.update({where:{id:cover},data:{endAt:new Date(start+300000)}}));});
   if(index===22)setAfterPickReadForTests(async()=>{setAfterPickReadForTests(null);await quarterWrite(prisma,tx=>tx.boardOverlay.create({data:{id:`id-${index}`,date,board:"caja",kind:"remove",employeeId:requester,stationId:"green1",startAt:new Date(start),endAt:new Date(start+900000),managerId:"fixture",managerName:"Synthetic"}}));});
   if(index===23){
    assert.deepEqual(await pickDueCovers(new Date(start-300001),prisma),zero);
    assert.deepEqual(await pickDueCovers(new Date(start-300001),prisma),zero);
   }
   const first=await pickDueCovers(now,prisma);
   assert.deepEqual(first,index===19?{...zero,ended:1}:index===23?{...zero,picked:1}:index>=24?zero:{...zero,rolled:1},cases[offset]);
  }
  assert.deepEqual(await pickDueCovers(now,prisma),zero,`repeat:${cases[offset]}`);
  if(index===23){
   for(const instant of [start,start+900000]){
    assert.deepEqual(await pickDueCovers(new Date(instant),prisma),zero);
    assert.deepEqual(await pickDueCovers(new Date(instant),prisma),zero);
   }
  }
  const booking=await prisma.staffBreak.findUniqueOrThrow({where:{id:`${id}-due`}});
  const views=await prisma.$transaction(async tx=>{
   const shifts=await tx.shift.findMany({where:{date}}),paints=await decisionPaints(tx,date);
   const breaks=await tx.staffBreak.findMany({where:{date}}),overlays=(await loadOverlayRecords(tx,null,date)).map(o=>({...toSliceOverlay(o),board:o.board}));
   return (['caja','cocina'] as const).map(board=>{
    const slices=buildDaySlices({date,board,now,stations:[],starStationIds:MANDATORY_STATIONS_BY_BOARD[board],
     shifts:shifts.map(s=>({...s,superseded:!!s.supersededAt})),paints,breaks:breaks.flatMap(b=>b.status==="pending"||b.status==="booked"?[{...b,status:b.status}]:[]),overlays});
    return {board,slices:slices.slices.filter(s=>[start-900000,start,start+900000].includes(+s.start))};
   });
  });
  if(index===23||index===24||index===25){
   const at=(board:string,instant:number)=>views.find(v=>v.board===board)!.slices.find(s=>+s.start===instant)!;
   assert.equal(at('caja',start).seats.find(s=>s.stationId==='green1')?.employeeId,index===25?`${id}-picker-purple1`:cover);
   assert.equal(at('caja',start+900000).seats.find(s=>s.stationId==='green1')?.employeeId,requester);
   if(index===24){
    assert(!at('cocina',start).seats.some(s=>s.employeeId===cover));
    assert.equal(at('cocina',start+900000).seats.find(s=>s.stationId==='pdf_tq2r')?.employeeId,cover);
   }
   if(index===25)assert.equal(at('caja',start).seats.find(s=>s.stationId==='purple1')?.employeeId,cover);
  }
  const displays=await prisma.$transaction(async tx=>({caja:(await readQuarterDay(tx,"caja",date,new Date(start))).coverDisplay,cocina:(await readQuarterDay(tx,"cocina",date,new Date(start))).coverDisplay}));
  results.push({case:cases[offset],booking,views,displays});
 }
 writeFileSync(output,JSON.stringify(results)+"\n");
 if(mode==="after")assert.deepEqual(JSON.parse(JSON.stringify(results)),JSON.parse(readFileSync(prior,"utf8")),"PICKER_RECOVERY_CHANGED");
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{setAfterPickReadForTests(null);return prisma.$disconnect();});
