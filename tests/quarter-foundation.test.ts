import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { migrateQuarterStorage, quarterState, worldRevision, verifyQuarterSchema, CAPABILITY_SHA256, digest } from "@/lib/quarter/schema";
import { withReleaseLease } from "@/lib/quarter/lease";
import { resolvePaintWorld, sourceSnapshot, assignedIntervals } from "@/lib/quarter/world";
import { paintV2, quarterWrite } from "@/lib/quarter/transaction";
import { quarterInstant } from "@/lib/quarter/protocol";
import { reconcileSource } from "@/lib/quarter/reconcile";
import { assertArtifactCompatibility, refuseSchemaPush } from "@/lib/quarter/compatibility";
import { readQuarterDay } from "@/lib/quarter/public";
import { chicagoHourStart } from "@/lib/hour-grid";

const date="2038-10-12", now=new Date("2038-10-12T12:00:00Z"), actor={id:"synthetic-manager",name:"Synthetic"};
const root=fs.mkdtempSync(path.join(process.env.FLOOR_BOARDS_TEST_ROOT!,"quarter-foundation-"));
const originalDatabaseUrl=process.env.DATABASE_URL;
const dbUrl=`file:${path.join(root,"test.db")}`;
const db=new PrismaClient({datasources:{db:{url:dbUrl}}});
const hour=+chicagoHourStart(date,13);
async function command(shiftId:string,quarter:string,action:{action:"erase"}|{action:"station";stationId:string},requestId=randomUUID()) {
  const w=await db.$transaction(tx=>resolvePaintWorld(tx,date));
  const s=w.sources.find(s=>s.id===shiftId)!;const h=w.hours.find(h=>h.shiftId===shiftId&&h.hourStartMs===hour)!;
  return {protocol:2 as const,requestId,capabilitySha256:CAPABILITY_SHA256,board:"caja" as const,date,
    expected:{databaseEpoch:w.state!.databaseEpoch,worldRevision:w.revision!},
    sources:[{shiftId:s.id,employeeId:s.employeeId,date:s.date,board:s.board as "caja",sourcePosition:s.sourcePosition,startAt:s.startAt.toISOString(),endAt:s.endAt.toISOString(),supersededAt:null,boardRemoved:false}],
    hours:[h.revision===null?{shiftId,hourStart:new Date(hour).toISOString(),revision:null,legacySha256:h.legacySha256}:{shiftId,hourStart:new Date(hour).toISOString(),revision:h.revision}],
    intents:[{shiftId,quarter,...action}]};
}
describe("quarter foundation, isolated prepared migration and active transaction proofs",()=>{
  beforeAll(async()=>{
    process.env.DATABASE_URL=dbUrl;
    fs.writeFileSync(path.join(root,"test.db"),"");
    execFileSync("pnpm",["exec","prisma","db","push","--skip-generate"],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:dbUrl},stdio:"pipe"});
    for(const [id,order] of [["green1",1],["green2",2],["purple1",3],["purple2",4]] as const)
      await db.station.create({data:{id,board:"caja",label:id,color:"#00ff00",maxConcurrent:1,sortOrder:order}});
    for(const id of ["a","b","c"]){
      await db.employee.create({data:{id,externalId:`synthetic-${id}`,firstName:id,lastName:"Fixture"}});
      await db.shift.create({data:{id:`shift-${id}`,employeeId:id,date,board:"caja",sourcePosition:"Caja",startAt:new Date(hour),endAt:new Date(hour+60*60_000)}});
    }
    await db.assignment.create({data:{id:"legacy-a",shiftId:"shift-a",employeeId:"a",stationId:"green1",hourStart:new Date(hour),hourEnd:new Date(hour+3600000)}});
    await db.assignment.create({data:{id:"legacy-b",shiftId:"shift-b",employeeId:"b",stationId:"green2",hourStart:new Date(hour),hourEnd:new Date(hour+3600000)}});
  },60_000);
  afterAll(async()=>{await db.$disconnect();process.env.DATABASE_URL=originalDatabaseUrl;fs.rmSync(root,{recursive:true,force:true});});
  it("requires release ownership; migration repeats without epoch/revision reset and leaves hourly rows intact",async()=>{
    await expect(migrateQuarterStorage(db)).rejects.toMatchObject({code:"RELEASE_LEASE_REQUIRED"});
    const first=await withReleaseLease(()=>migrateQuarterStorage(db),db);
    expect(first.repeated).toBe(false);
    expect(await worldRevision(db)).toBe("0");
    await db.assignment.update({where:{id:"legacy-a"},data:{seatNumber:null}});
    expect(await worldRevision(db)).toBe("1");
    expect(await withReleaseLease(()=>migrateQuarterStorage(db),db)).toEqual({...first,repeated:true});
    expect(await worldRevision(db)).toBe("1");
    expect(await db.assignment.count()).toBe(2);
    await expect(refuseSchemaPush(db)).rejects.toMatchObject({code:"QUARTER_EXPLICIT_MIGRATION_REQUIRED"});
  });
  it("prepared mode disables quarter writes but preserves the old hourly world",async()=>{
    const body=await command("shift-a","13:15",{action:"erase"});
    const publicDay=await db.$transaction(tx=>readQuarterDay(tx,"caja",date,now));
    expect(publicDay.hours.find(h=>h.shiftId==="shift-b")!.intervals.every(s=>s.seatNumber===2)).toBe(true);
    expect((await db.assignment.findUnique({where:{id:"legacy-b"}}))!.seatNumber).toBeNull();
    await expect(paintV2(body,actor,now,db)).rejects.toMatchObject({code:"QUARTER_NOT_ACTIVE"});
    expect(assignedIntervals(await db.$transaction(tx=>resolvePaintWorld(tx,date))).filter(s=>s.employeeId==="a").length).toBe(4);
  });
  it("synthetic activation enables exact erasure and atomic peer adoption without changing legacy rows",async()=>{
    // Only this isolated fixture sets active; no activation command is shipped in the foundation.
    await db.$executeRawUnsafe("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=? WHERE id=1",+now);
    await assertArtifactCompatibility(db);
    const legacy=await db.assignment.findMany({orderBy:{id:"asc"}});
    const body=await command("shift-a","13:15",{action:"erase"});
    const result=await paintV2(body,actor,now,db);
    expect(result.hours.map(h=>h.shiftId).sort()).toEqual(["shift-a","shift-b"]);
    const w=await db.$transaction(tx=>resolvePaintWorld(tx,date));
    expect(w.hours.find(h=>h.shiftId==="shift-a")!.segments.map(s=>s.state)).toEqual(["assigned","erased","assigned","assigned"]);
    expect(w.hours.find(h=>h.shiftId==="shift-b")!.segments.every(s=>s.seatNumber===2)).toBe(true);
    expect(await db.assignment.findMany({orderBy:{id:"asc"}})).toEqual(legacy);
    const after=await worldRevision(db);
    expect(await paintV2(body,actor,now,db)).toEqual(result);
    expect(await worldRevision(db)).toBe(after);
    await expect(paintV2({...body,intents:[{shiftId:"shift-a",quarter:"13:30",action:"erase"}]},actor,now,db)).rejects.toMatchObject({code:"REQUEST_ID_REUSE"});
  });
  it("stale world expectations cannot overwrite a later commit",async()=>{
    const stale=await command("shift-a","13:30",{action:"erase"});
    await db.station.update({where:{id:"purple1"},data:{label:"Changed"}});
    await expect(paintV2(stale,actor,now,db)).rejects.toMatchObject({code:"REVISION_CONFLICT"});
  });
  it("person/seat conflicts roll back adoption, audit and receipt",async()=>{
    const body=await command("shift-c","13:00",{action:"station",stationId:"green2"});
    const revision=await worldRevision(db);
    await expect(paintV2(body,actor,now,db)).rejects.toMatchObject({code:"STATION_FULL",status:409});
    expect(await worldRevision(db)).toBe(revision);
    expect((await db.$queryRawUnsafe<{n:bigint}[]>("SELECT COUNT(*) n FROM PaintHour WHERE shiftId='shift-c'"))[0].n).toBe(BigInt(0));
    expect((await db.$queryRawUnsafe<{n:bigint}[]>("SELECT COUNT(*) n FROM PaintCommandReceipt WHERE requestId=?",body.requestId))[0].n).toBe(BigInt(0));
  });
  it("old Assignment DML and source-only changes cannot bypass protocol guards",async()=>{
    await expect(db.$executeRawUnsafe("DELETE FROM Assignment WHERE id='legacy-a'")).rejects.toThrow("QUARTER_PROTOCOL_REQUIRED");
    await expect(db.$executeRawUnsafe("UPDATE Shift SET board='cocina' WHERE id='shift-a'")).rejects.toThrow("QUARTER_SOURCE_IDENTITY_IMMUTABLE");
    await expect(db.$executeRawUnsafe("UPDATE Shift SET endAt=? WHERE id='shift-a'",hour+20*60_000)).rejects.toThrow("QUARTER_SOURCE_RECONCILE_REQUIRED");
  });
  it("source shrink/extension preserves factual minutes, erasures and old snapshots",async()=>{
    const s=(await db.shift.findUnique({where:{id:"shift-a"}}))!;
    const requestId="synthetic-reconcile";
    await quarterWrite(db,async tx=>{
      await reconcileSource(tx,{shiftId:s.id,expectedSourceSha256:digest(sourceSnapshot(s)),patch:{endAt:new Date(hour+20*60_000)},actor,requestId,now});
      const schema=(await quarterState(tx))!;
      await tx.$executeRawUnsafe("INSERT INTO PaintCommandReceipt VALUES (?,?,?,?,?,?,?,?)",actor.id,requestId,"a".repeat(64),schema.databaseEpoch,"0",await worldRevision(tx),"{}",+now);
    });
    let w=await db.$transaction(tx=>resolvePaintWorld(tx,date));
    const h=w.hours.find(h=>h.shiftId===s.id)!;
    expect(h.segments.map(s=>[s.startMs-hour,s.endMs-hour,s.state])).toEqual([[0,900000,"assigned"],[900000,1200000,"erased"],[1200000,1800000,"off"],[1800000,2700000,"off"],[2700000,3600000,"off"]]);
    const current=(await db.shift.findUnique({where:{id:s.id}}))!;
    await expect(quarterWrite(db,async tx=>{
      await reconcileSource(tx,{shiftId:s.id,expectedSourceSha256:digest(sourceSnapshot(current)),patch:{endAt:new Date(hour+30*60_000)},actor,requestId:"rollback",now});
      throw new Error("injected failure after source update");
    })).rejects.toThrow("injected failure");
    w=await db.$transaction(tx=>resolvePaintWorld(tx,date));
    expect(w.hours.find(h=>h.shiftId===s.id)).toEqual(h);
  });
  it("mixed whole hour refuses; a partial source with uniform paint can use an hour command",async()=>{
    const body=await command("shift-a","13:00",{action:"station",stationId:"purple1"});
    await expect(paintV2({...body,intents:[{...body.intents[0],granularity:"hour"}]},actor,now,db)).rejects.toMatchObject({code:"HOUR_NEEDS_QUARTER",status:409,details:{conflicts:expect.arrayContaining([expect.objectContaining({shiftId:"shift-a",reason:"MIXED_BASE"})])}});
    const erase=await command("shift-a","13:00",{action:"erase"});await paintV2(erase,actor,now,db);
    const uniform=await command("shift-a","13:00",{action:"station",stationId:"purple1"});
    await paintV2({...uniform,intents:[{...uniform.intents[0],granularity:"hour"}]},actor,now,db);
    const work=assignedIntervals(await db.$transaction(tx=>resolvePaintWorld(tx,date))).filter(s=>s.employeeId==="a");
    expect(work.reduce((total,s)=>total+s.endMs-s.startMs,0)).toBe(20*60_000);
  });
  it("public V2 intervals exclude capabilities, private fields and legacy snapshots",async()=>{
    const day=await db.$transaction(tx=>readQuarterDay(tx,"caja",date,now));
    const serialized=JSON.stringify(day);
    for(const key of ["abilities","email","codeHash","legacyJson","sourceJson"])expect(serialized).not.toContain(`"${key}"`);
    expect(day.schemaVersion).toBe(2);expect(day.hours.some(h=>h.revision!==null)).toBe(true);
    expect(quarterInstant(date,"13:15")).toBe(hour+900000);
    expect(()=>quarterInstant("2038-02-31","13:15")).toThrow("INVALID_QUARTER");
  });
  it("an active foundation needs the synthetic environment and oversized commands do not write",async()=>{
    const saved=process.env.FLOOR_BOARDS_TEST_ROOT;
    try {delete process.env.FLOOR_BOARDS_TEST_ROOT;await expect(assertArtifactCompatibility(db)).rejects.toMatchObject({code:"FOUNDATION_NOT_RECOVERY_ARTIFACT"});}
    finally {process.env.FLOOR_BOARDS_TEST_ROOT=saved;}
    const body=await command("shift-a","13:15",{action:"erase"}),revision=await worldRevision(db);
    await expect(paintV2({...body,intents:Array.from({length:2001},()=>body.intents[0])},actor,now,db)).rejects.toMatchObject({status:413});
    expect(await worldRevision(db)).toBe(revision);
  });
  it("schema drift refuses an idempotent migration instead of resetting the epoch",async()=>{
    await db.$executeRawUnsafe("DROP TRIGGER qv2_legacy_assignment_delete");
    await expect(verifyQuarterSchema(db)).rejects.toMatchObject({code:"QUARTER_SCHEMA_DRIFT:qv2_legacy_assignment_delete"});
    await expect(withReleaseLease(()=>migrateQuarterStorage(db),db)).rejects.toMatchObject({code:"QUARTER_SCHEMA_DRIFT:qv2_legacy_assignment_delete"});
  });
});
