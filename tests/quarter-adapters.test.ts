import { beforeAll,afterAll,beforeEach,afterEach,describe,it,expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { migrateQuarterStorage,worldRevision,quarterState,CAPABILITY_SHA256,digest } from "@/lib/quarter/schema";
import { withReleaseLease } from "@/lib/quarter/lease";
import { captureQuarterPreservation,PRESERVATION_COLUMNS } from "@/lib/quarter/preservation";
import { paintV2,quarterWrite } from "@/lib/quarter/transaction";
import { resolvePaintWorld,sourceSnapshot,assignedIntervals } from "@/lib/quarter/world";
import { operateV2 } from "@/lib/quarter/operations";
import { removeRestoreV2 } from "@/lib/quarter/removals";
import { commitImport,previewImport } from "@/lib/import/persist-import";
import { quarterFavorites } from "@/lib/quarter/suggestions";
import { reconcileSource } from "@/lib/quarter/reconcile";
import type { ParseResult,ParsedShift } from "@/lib/parser/schedule-parser";
import { chicagoHourStart } from "@/lib/hour-grid";

const date="2038-10-12", nextDate="2038-10-13", hour=+chicagoHourStart(date,13), now=new Date(hour-3600000);
const actor={id:"synthetic-reviewer",name:"Synthetic"};
const root=fs.mkdtempSync(path.join(process.env.FLOOR_BOARDS_TEST_ROOT!,"quarter-adapters-"));
const template=path.join(root,"prepared.db");let db:PrismaClient,dbFile:string;
const url=(p:string)=>`file:${p}`;
async function activate(){await db.$executeRawUnsafe("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=? WHERE id=1",+now);}
async function shift(id:string,options:{date?:string;start?:number;end?:number;board?:string;employeeId?:string}={}) {
  const employeeId=options.employeeId??id;
  await db.employee.upsert({where:{id:employeeId},create:{id:employeeId,externalId:employeeId,firstName:employeeId,lastName:"Synthetic"},update:{}});
  return db.shift.create({data:{id:`source-${id}`,employeeId,date:options.date??date,board:options.board??"caja",sourcePosition:"Synthetic regular",startAt:new Date(options.start??hour),endAt:new Date(options.end??hour+3600000)}});
}
async function envelope(day=date) {
  const world=await db.$transaction(tx=>resolvePaintWorld(tx,day));
  return {protocol:2 as const,requestId:randomUUID(),capabilitySha256:CAPABILITY_SHA256,board:"caja" as const,date:day,
    expected:{databaseEpoch:world.state!.databaseEpoch,worldRevision:world.revision!},
    sources:world.sources.filter(s=>!s.supersededAt&&!s.boardRemoved).map(s=>({shiftId:s.id,employeeId:s.employeeId,date:s.date,board:s.board as "caja",sourcePosition:s.sourcePosition,startAt:s.startAt.toISOString(),endAt:s.endAt.toISOString(),supersededAt:null,boardRemoved:false})),
    hours:world.hours.filter(h=>world.sources.some(s=>s.id===h.shiftId&&!s.supersededAt&&!s.boardRemoved)).map(h=>h.revision===null?
      {shiftId:h.shiftId,hourStart:new Date(h.hourStartMs).toISOString(),revision:null,legacySha256:h.legacySha256}:{shiftId:h.shiftId,hourStart:new Date(h.hourStartMs).toISOString(),revision:h.revision})};
}
async function paint(id:string,quarter:string,stationId:string|null,day=date) {
  const command={...await envelope(day),intents:[{shiftId:`source-${id}`,quarter,...(stationId?{action:"station",stationId}:{action:"erase"})}]};
  return paintV2(command,actor,now,db);
}
function schedule(rows:{id:string;start?:number;end?:number}[]):ParseResult {
  const shifts:ParsedShift[]=rows.map(r=>({externalId:r.id,firstName:r.id,lastName:"Synthetic",date,startAt:new Date(r.start??hour),endAt:new Date(r.end??hour+3600000),sourcePosition:"Synthetic regular",board:"caja",stationHint:null}));
  return {shifts,dates:[date],bucketCounts:{caja:shifts.length,cocina:0,other:0},strippedPayColumns:[]};
}
async function importSchedule(parsed:ParseResult,clock=now) {
  const preview=await previewImport(parsed,{client:db,now:clock});
  return commitImport(parsed,"synthetic.csv",{client:db,now:clock,expected:{fingerprint:preview.fingerprint,planDigest:preview.planDigest},initiator:{kind:"folder"}});
}
async function removeCommand(id:string,operation:"remove"|"restore",positions?:"replay"|"none") {
  const s=(await db.shift.findUnique({where:{id:`source-${id}`},include:{removalOverride:true}}))!;
  return {protocol:2,requestId:randomUUID(),capabilitySha256:CAPABILITY_SHA256,board:s.board,date:s.date,shiftId:s.id,operation,positions,reason:"Synthetic case",
    expected:{databaseEpoch:(await quarterState(db))!.databaseEpoch,worldRevision:await worldRevision(db),sourceSha256:digest(sourceSnapshot(s)),removalRevision:s.removalOverride?.revision??0}};
}
describe("quarter server adapters and data preservation",()=>{
  beforeAll(async()=>{
    fs.writeFileSync(template,"");execFileSync("pnpm",["exec","prisma","db","push","--skip-generate"],{env:{...process.env,DATABASE_URL:url(template)},stdio:"pipe"});
    const init=new PrismaClient({datasources:{db:{url:url(template)}}});
    for(const [id,board] of [["green1","caja"],["green2","caja"],["purple1","caja"],["purple2","caja"],["pdf_tq1r","cocina"]])
      await init.station.create({data:{id,board,label:id,color:"green",sortOrder:1,maxConcurrent:1}});
    const before=await init.$transaction(tx=>captureQuarterPreservation(tx,false));
    await withReleaseLease(()=>migrateQuarterStorage(init));
    const after=await init.$transaction(tx=>captureQuarterPreservation(tx));
    expect(Object.keys(PRESERVATION_COLUMNS)).toHaveLength(26);
    for(const table of Object.keys(before.tables).filter(t=>t!=="StaffBreakLock"))expect(after.tables[table]).toEqual(before.tables[table]);
    expect(after.foreignKeys).toBe(1);expect(after.foreignKeyViolations).toBe(0);
    await init.$disconnect();
  },60_000);
  beforeEach(()=>{dbFile=path.join(root,`${randomUUID()}.db`);fs.copyFileSync(template,dbFile);db=new PrismaClient({datasources:{db:{url:url(dbFile)}}});});
  afterEach(async()=>{await db.$disconnect();});
  afterAll(()=>fs.rmSync(root,{recursive:true,force:true}));

  it("same original revision permits only one concurrent commit and replay retires exactly its generation",async()=>{
    await shift("a");await activate();
    const base=await envelope();
    const first={...base,draftSubmission:{episodeId:"episode",generationId:"g1",generationSha256:"a".repeat(64)},intents:[{shiftId:"source-a",quarter:"13:00",action:"station",stationId:"purple1"}]};
    const second={...base,requestId:randomUUID(),intents:[{shiftId:"source-a",quarter:"13:15",action:"station",stationId:"purple2"}]};
    const results=await Promise.allSettled([paintV2(first,actor,now,db),paintV2(second,actor,now,db)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const winner=results[0].status==="fulfilled"?first:second;
    const committed=results.find(r=>r.status==="fulfilled")!;
    const replay=await paintV2(winner,actor,now,db);expect(replay).toEqual(committed.status==="fulfilled"?committed.value:null);
    expect(replay.dates).toEqual([date]);
    const later=await paint("a","13:30","purple2");
    expect(await paintV2(winner,actor,now,db)).toEqual(replay);
    expect(later.committedRevision).not.toBe(replay.committedRevision);
  });
  it("copy requires its exact preview, clips factual minutes and never overwrites an adopted target",async()=>{
    await shift("a");const target=+chicagoHourStart(nextDate,13);await shift("b",{date:nextDate,start:target,end:target+1200000});await activate();
    await paint("a","13:00","purple1");await paint("a","13:15","purple1");
    const destination=await envelope(nextDate),source=await envelope();
    const op={...destination,operation:"copy",sourceDate:date,sourceSources:source.sources,sourceHours:source.hours,mapping:[{fromShiftId:"source-a",toShiftId:"source-b"}],mode:"preview"};
    const preview=await operateV2(op,actor,now,db);expect(preview).toMatchObject({preview:true,clippedMinutes:10});
    await expect(operateV2({...op,mode:"commit"},actor,now,db)).rejects.toMatchObject({code:"COPY_PREVIEW_CHANGED"});
    const result=await operateV2({...op,mode:"commit",previewSha256:"previewSha256" in preview?preview.previewSha256:undefined},actor,now,db);
    expect(result).toMatchObject({clippedMinutes:10,dates:[nextDate,date]});
    const intervals=assignedIntervals(await db.$transaction(tx=>resolvePaintWorld(tx,nextDate)));
    expect(intervals.reduce((n,s)=>n+s.endMs-s.startMs,0)).toBe(1200000);
    const fresh={...op,...await envelope(nextDate),mode:"preview"};
    await expect(operateV2(fresh,actor,now,db)).rejects.toMatchObject({code:"COPY_TARGET_NOT_EMPTY"});
  });
  it("whole-shift and swap preserve atomicity and interval identity",async()=>{
    await shift("a");await shift("b");await activate();await paint("a","13:00","purple1");await paint("b","13:00","purple2");
    const swap={...await envelope(),operation:"swap",leftShiftId:"source-a",rightShiftId:"source-b",quarter:"13:00",granularity:"quarter"};
    await operateV2(swap,actor,now,db);
    const work=assignedIntervals(await db.$transaction(tx=>resolvePaintWorld(tx,date)));
    expect(work.find(s=>s.employeeId==="a")?.stationId).toBe("purple2");
    expect(work.find(s=>s.employeeId==="b")?.stationId).toBe("purple1");
    await expect(operateV2({...await envelope(),operation:"whole-shift",shiftId:"source-a",stationId:"green1"},actor,now,db)).rejects.toMatchObject({code:"HOUR_NEEDS_QUARTER"});
  });
  it("remove and restore retain original interval snapshots; conflicts roll everything back",async()=>{
    await shift("a");await shift("b");await activate();await paint("a","13:00","purple1");
    await removeRestoreV2(await removeCommand("a","remove"),actor,now,db);
    const snapshot=(await db.shiftRemoval.findUnique({where:{shiftId:"source-a"}}))!.cellsJson;
    expect(assignedIntervals(await db.$transaction(tx=>resolvePaintWorld(tx,date))).filter(s=>s.employeeId==="a")).toHaveLength(0);
    await paint("b","13:00","purple1");
    const revision=await worldRevision(db);
    await expect(removeRestoreV2(await removeCommand("a","restore","replay"),actor,now,db)).rejects.toMatchObject({code:"STATION_FULL"});
    expect(await worldRevision(db)).toBe(revision);expect((await db.shift.findUnique({where:{id:"source-a"}}))!.boardRemoved).toBe(true);
    await paint("b","13:00",null);
    await removeRestoreV2(await removeCommand("a","restore","replay"),actor,now,db);
    expect((await db.shiftRemoval.findUnique({where:{shiftId:"source-a"}}))!.cellsJson).toBe(snapshot);
    expect(assignedIntervals(await db.$transaction(tx=>resolvePaintWorld(tx,date))).filter(s=>s.employeeId==="a").reduce((n,s)=>n+s.endMs-s.startMs,0)).toBe(900000);
  });
  it("source reconciliation increments an hour only once within one command and rolls back all source bytes",async()=>{
    await shift("a");await activate();await paint("a","13:00","purple1");
    const prior=await db.$transaction(tx=>resolvePaintWorld(tx,date)),revision=prior.hours[0].revision!;
    await quarterWrite(db,async tx=>{
      for(const endAt of [new Date(hour+3000000),new Date(hour+2700000)]){
        const source=(await tx.shift.findUnique({where:{id:"source-a"}}))!;
        await reconcileSource(tx,{shiftId:source.id,expectedSourceSha256:digest(sourceSnapshot(source)),patch:{endAt},actor,requestId:"source-twice",now});
      }
      await tx.$executeRawUnsafe("INSERT INTO PaintCommandReceipt VALUES (?,?,?,?,?,?,?,?)",actor.id,"source-twice","f".repeat(64),prior.state!.databaseEpoch,prior.revision,await worldRevision(tx),"{}",+now);
    });
    const after=await db.$transaction(tx=>resolvePaintWorld(tx,date));expect(after.hours[0].revision).toBe((BigInt(revision)+BigInt(1)).toString());
  });
  it("import takeover preserves future erasure, original receipt and fixed skip list across a different entry",async()=>{
    await activate();await importSchedule(schedule([{id:"a"}]));
    const source=await db.shift.findFirstOrThrow({where:{employee:{externalId:"a"}}});
    await paintV2({...await envelope(),intents:[{shiftId:source.id,quarter:"13:00",action:"station",stationId:"purple1"}]},actor,now,db);
    await db.positionStationMap.create({data:{position:"Synthetic regular",stationId:"green1"}});
    const result=await importSchedule(schedule([{id:"b"}]));
    const world=await db.$transaction(tx=>resolvePaintWorld(tx,date));
    expect(world.sources.find(s=>s.id===source.id)?.supersededAt).not.toBeNull();
    const incoming=world.sources.find(s=>!s.supersededAt)!;
    expect(world.hours.find(h=>h.shiftId===incoming.id)?.segments.map(s=>s.state)).toEqual(["assigned","erased","erased","erased"]);
    expect(result.fixedSkipped).toEqual([{shiftId:incoming.id,hour:13,reason:"ADOPTED_HOUR"}]);
    const rev=await worldRevision(db);
    expect(await commitImport(schedule([{id:"b"}]),"different-name.csv",{client:db,now,initiator:{kind:"hourly"}})).toEqual({...result,replayed:true});
    expect(await worldRevision(db)).toBe(rev);
  });
  it("a changed started clip uses a new source, while future shrink retains exact paint and extends with erase",async()=>{
    await activate();await importSchedule(schedule([{id:"a"}]));let env=await envelope();const id=env.sources[0].shiftId;
    await paintV2({...env,intents:[{shiftId:id,quarter:"13:00",action:"station",stationId:"purple1"},{shiftId:id,quarter:"13:15",action:"station",stationId:"purple1"}]},actor,now,db);
    await importSchedule(schedule([{id:"a",end:hour+1200000}]));
    expect(assignedIntervals(await db.$transaction(tx=>resolvePaintWorld(tx,date))).reduce((n,s)=>n+s.endMs-s.startMs,0)).toBe(1200000);
    await importSchedule(schedule([{id:"a",end:hour+1800000}]));
    env=await envelope();expect(env.sources[0].shiftId).toBe(id);
    expect(assignedIntervals(await db.$transaction(tx=>resolvePaintWorld(tx,date))).reduce((n,s)=>n+s.endMs-s.startMs,0)).toBe(1200000);
    await importSchedule(schedule([{id:"a",end:hour+600000}]),new Date(hour+300000));
    const world=await db.$transaction(tx=>resolvePaintWorld(tx,date));expect(world.sources).toHaveLength(2);
    expect(world.sources.find(s=>s.id===id)?.supersededAt).not.toBeNull();
    expect(assignedIntervals(world,false).filter(s=>s.shiftId===id).reduce((n,s)=>n+s.endMs-s.startMs,0)).toBe(1200000);
  });
  it("booked source invalidation refuses the entire import before receipt or fingerprint",async()=>{
    await activate();await importSchedule(schedule([{id:"a"},{id:"b"}]));
    const sources=await db.shift.findMany({include:{employee:true}}),a=sources.find(s=>s.employee.externalId==="a")!,b=sources.find(s=>s.employee.externalId==="b")!;
    await db.staffBreak.create({data:{employeeId:a.employeeId,shiftId:a.id,board:"caja",date,startAt:new Date(hour),endAt:new Date(hour+1800000),status:"booked",coverEmployeeId:b.employeeId,coverShiftId:b.id,actor:"manager"}});
    const revision=await worldRevision(db),batches=await db.importBatch.count();
    await expect(importSchedule(schedule([{id:"a"},{id:"b",end:hour+900000}]))).rejects.toMatchObject({code:"PERSISTED_COVER_CONFLICT"});
    expect(await db.importBatch.count()).toBe(batches);expect(await worldRevision(db)).toBe(revision);
  });
  it("exact-interval suggestions distinguish erased time from later paint without exposing abilities",async()=>{
    await shift("a");await activate();await db.employeeStationAbility.create({data:{employeeId:"a",stationId:"purple1",level:"preferred"}});
    await paint("a","13:30","purple2");
    const free=await db.$transaction(tx=>quarterFavorites(tx,{date,board:"caja",quarter:"13:00",granularity:"quarter"}));
    expect(free.candidates.find(c=>c.stationId==="purple1")?.candidate?.employeeId).toBe("a");
    const busy=await db.$transaction(tx=>quarterFavorites(tx,{date,board:"caja",quarter:"13:30",granularity:"quarter"}));
    expect(busy.candidates.every(c=>c.candidate===null)).toBe(true);expect(JSON.stringify(free)).not.toContain('"level"');
  });
});
