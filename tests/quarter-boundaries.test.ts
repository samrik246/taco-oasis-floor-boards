import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const fixture=vi.hoisted(()=>({db:null as PrismaClient|null,manager:false}));
vi.mock("@/lib/db",()=>({get prisma(){return fixture.db!;}}));
vi.mock("@/lib/managers/require-session",()=>({
  requireManagerSession:async()=>fixture.manager?{ok:true,manager:{id:"synthetic-manager",name:"Synthetic"}}:{ok:false,response:NextResponse.json({error:"Unauthorized"},{status:401})},
  requireOwnerSession:async()=>({ok:false,response:NextResponse.json({error:"Unauthorized"},{status:401})}),
}));
import { artifactAppDir, quarterAppDir, quarterLeaseAppDir, withReleaseLease } from "@/lib/quarter/lease";
import { assertArtifactCompatibility } from "@/lib/quarter/compatibility";
import { migrateQuarterStorage, worldRevision } from "@/lib/quarter/schema";
import { resolvePaintWorld } from "@/lib/quarter/world";
import { readQuarterDay } from "@/lib/quarter/public";
import { listShiftRemovals } from "@/lib/shifts/remove-restore";
import { GET as dayGet } from "@/app/api/v2/boards/[board]/days/[date]/route";
import { GET as removalsGet } from "@/app/api/shift-removals/route";
import { POST as movePost } from "@/app/api/position-moves/route";
import { logPositionMove, listPositionMoves } from "@/lib/position-moves-service";
import { cancelOverlay } from "@/lib/overlays/write";
import { withStaffBreakLock } from "@/lib/breaks/rules";
import { commitImport, previewImport, fingerprintFor } from "@/lib/import/persist-import";
import { runFolderImport, formatSummary, EXIT_CODES } from "@/lib/import/folder-import";
import { startsNextWeek } from "@/lib/wiw-export/run";
import { parseSchedulesCsv } from "@/lib/parser/schedule-parser";
import { syntheticCsv } from "./helpers/synthetic-schedule";
import { chicagoToday } from "@/lib/upcoming/source";
import { chicagoHourStart } from "@/lib/hour-grid";
import { releaseLockPathFor } from "@/lib/release-lock";

const testRoot=process.env.FLOOR_BOARDS_TEST_ROOT!;
const originalUrl=process.env.DATABASE_URL!;
const root=fs.mkdtempSync(path.join(testRoot,"quarter-boundaries-"));
const template=path.join(root,"prepared.db"), repo=artifactAppDir();
const date=chicagoToday(), hour=+chicagoHourStart(date,13), now=new Date(hour);
let db:PrismaClient,file:string,queries:string[];
async function activate(){await db.$executeRawUnsafe("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=? WHERE id=1",+now);}
async function source(id:string,options:{removed?:boolean;superseded?:boolean;board?:string;assigned?:boolean}={}) {
  await db.employee.create({data:{id,externalId:id,firstName:`Name-${id}`,lastName:"Synthetic"}});
  const s=await db.shift.create({data:{id:`source-${id}`,employeeId:id,date,board:options.board??"caja",sourcePosition:"Caja",startAt:new Date(hour),endAt:new Date(hour+3600000),boardRemoved:options.removed??false,supersededAt:options.superseded?now:null}});
  if(options.assigned)await db.assignment.create({data:{id:`assignment-${id}`,shiftId:s.id,employeeId:id,stationId:options.board==="cocina"?"kitchen":"purple1",hourStart:new Date(hour),hourEnd:new Date(hour+3600000)}});
  return s;
}
function child(script:string,cwd:string,extra:Record<string,string>={}) {
  return new Promise<{code:number|null;output:string}>(resolve=>{
    const p=spawn(process.execPath,[path.join(repo,"node_modules/tsx/dist/cli.mjs"),"--tsconfig",path.join(repo,"tsconfig.json"),path.isAbsolute(script)?script:path.join(repo,script)],{cwd,env:{...process.env,...extra},stdio:["ignore","pipe","pipe"]});
    let output="";p.stdout.on("data",b=>output+=b);p.stderr.on("data",b=>output+=b);p.on("close",code=>resolve({code,output}));
  });
}
beforeAll(async()=>{
  fs.writeFileSync(template,"");process.env.DATABASE_URL=`file:${template}`;
  execFileSync("pnpm",["exec","prisma","db","push","--skip-generate"],{cwd:repo,env:process.env,stdio:"pipe"});
  const init=new PrismaClient();
  for(const [id,board] of [["purple1","caja"],["kitchen","cocina"]])await init.station.create({data:{id,board,label:id,color:"purple",sortOrder:1,maxConcurrent:1}});
  await withReleaseLease(()=>migrateQuarterStorage(init),init);await init.$disconnect();
},60_000);
beforeEach(()=>{
  process.env.FLOOR_BOARDS_TEST_ROOT=testRoot;file=path.join(root,`${randomUUID()}.db`);fs.copyFileSync(template,file);process.env.DATABASE_URL=`file:${file}`;
  const client=new PrismaClient({log:[{emit:"event",level:"query"}]});queries=[];client.$on("query",e=>queries.push(e.query));db=client;fixture.db=db;fixture.manager=false;
});
afterEach(async()=>{await db.$disconnect();process.env.FLOOR_BOARDS_TEST_ROOT=testRoot;process.env.DATABASE_URL=originalUrl;});
afterAll(()=>fs.rmSync(root,{recursive:true,force:true}));

describe("quarter foundation review boundaries",()=>{
  it.each(["prepared","active"])("%s public HTTP hides removed people, hours and display evidence but keeps canonical history",async phase=>{
    const removed=await source("removed",{removed:true,assigned:true});
    await source("visible");await source("started-history",{superseded:true,assigned:true});await source("empty-history",{superseded:true});await source("cross-board",{board:"cocina",assigned:true});
    await db.shiftRemoval.create({data:{shiftId:removed.id,externalId:"removed",date,board:"caja",sourcePosition:removed.sourcePosition,startAt:removed.startAt,endAt:removed.endAt,cellsJson:"[]"}});
    await db.staffBreak.create({data:{id:"removed-break",employeeId:"removed",shiftId:removed.id,date,board:"caja",startAt:new Date(hour),endAt:new Date(hour+900000),status:"booked",actor:"staff"}});
    if(phase==="active")await activate();
    const response=await dayGet(new Request("http://local/day"),{params:Promise.resolve({board:"caja",date})});
    expect(response.status).toBe(200);const body=await response.json(),serialized=JSON.stringify(body);
    expect(body.phase).toBe(phase);expect(serialized).not.toContain("removed");expect(serialized).not.toContain("empty-history");
    expect(body.sources.map((s:{shiftId:string})=>s.shiftId)).toEqual(expect.arrayContaining(["source-visible","source-started-history","source-cross-board"]));
    expect(body.hours.some((h:{shiftId:string})=>h.shiftId==="source-started-history")).toBe(true);
    expect((await db.$transaction(tx=>resolvePaintWorld(tx,date))).sources.some(s=>s.id===removed.id)).toBe(true);
    expect((await listShiftRemovals("caja",date))[0].shiftId).toBe(removed.id);
    expect((await removalsGet(new Request(`http://local/removals?board=caja&date=${date}`))).status).toBe(401);
    if(phase==="prepared"){
      fixture.manager=true;const review=await removalsGet(new Request(`http://local/removals?board=caja&date=${date}`));
      expect(review.status).toBe(200);expect((await review.json()).removals[0].shiftId).toBe(removed.id);
    }
    expect(await db.$transaction(tx=>readQuarterDay(tx,"caja",date,now))).toMatchObject({phase});
  });
  it("legacy move helper and HTTP preserve prepared writes, refuse active DML and retain history",async()=>{
    await source("mover");fixture.manager=true;
    const move={date,hour:13,employeeId:"mover",fromStationId:"purple1",toStationId:null,reason:"Break",actor:{id:"synthetic-manager",name:"Synthetic",route:"position-move"}};
    expect(await logPositionMove(move)).toMatchObject({ok:true});
    await activate();const revision=await worldRevision(db),before=await db.positionMoveLog.count(),logs=await db.boardChangeLog.count();
    await expect(logPositionMove(move)).rejects.toMatchObject({code:"CLIENT_UPGRADE_REQUIRED"});
    const response=await movePost(new Request("http://local/position-moves",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(move)}));
    expect(response.status).toBe(426);expect(await db.positionMoveLog.count()).toBe(before);expect(await db.boardChangeLog.count()).toBe(logs);expect(await worldRevision(db)).toBe(revision);
    expect(await listPositionMoves(date)).toHaveLength(1);
  });
  it("cancellation takes the mutex before reading and waits for a competing board decision",async()=>{
    const s=await source("overlay");
    const row=await db.boardOverlay.create({data:{board:"caja",date,kind:"remove",stationId:"purple1",employeeId:s.employeeId,startAt:now,endAt:new Date(hour+900000),managerId:"synthetic-manager",managerName:"Synthetic"}});
    let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r);
    const competing=withStaffBreakLock(async tx=>{await tx.boardOverlay.findUniqueOrThrow({where:{id:row.id}});entered();await new Promise<void>(r=>release=r);});
    await ready;queries=[];
    const cancelled=cancelOverlay({manager:{id:"synthetic-manager",name:"Synthetic"},board:"caja",date,id:row.id,now}).then(()=>null,e=>e);
    try{await new Promise(r=>setTimeout(r,40));expect(queries.some(q=>/SELECT.*BoardOverlay/.test(q))).toBe(false);}
    finally{release();await competing;}
    expect(await cancelled).toBeNull();
    const statements=queries.filter(q=>!/^(BEGIN|COMMIT|ROLLBACK)/.test(q));expect(statements[0]).toContain("StaffBreakLock");
    expect((await db.boardOverlay.findUniqueOrThrow({where:{id:row.id}})).cancelledAt).toEqual(now);
  });
  it("active compatibility and lease override require canonical disposable roots and the actual configured DB",async()=>{
    await activate();await expect(assertArtifactCompatibility(db)).resolves.toBeUndefined();
    const valid=`file:${file}`;const link=path.join(root,"linked.db");fs.symlinkSync(file,link);
    const directoryLink=path.join(root,"linked-directory");fs.symlinkSync(path.dirname(file),directoryLink);
    const cases=[{root:path.dirname(testRoot),url:valid},{root:"/private/tmp",url:valid},{root:testRoot,url:`file:${link}`},
      {root:testRoot,url:`file:${directoryLink}/${path.basename(file)}`},{root:testRoot,url:`file:${template}`},
      {root:testRoot,url:"file:/Users/dan/.buzz/COLOR_BOARDS_APP/var/data/floor-boards.db"}];
    for(const item of cases){
      process.env.FLOOR_BOARDS_TEST_ROOT=item.root;process.env.DATABASE_URL=item.url;
      await expect(assertArtifactCompatibility(db)).rejects.toMatchObject({code:"SYNTHETIC_DATABASE_REQUIRED"});
      const run=vi.fn();await expect(withReleaseLease(run,db)).rejects.toMatchObject({code:"SYNTHETIC_DATABASE_REQUIRED"});expect(run).not.toHaveBeenCalled();
    }
    process.env.DATABASE_URL=valid;process.env.FLOOR_BOARDS_TEST_ROOT=testRoot;
    expect(await quarterLeaseAppDir(db)).toBe(path.join(testRoot,"app"));
  });
  it("the artifact identity is stable and both CLIs refuse a held lease from another launch directory",async()=>{
    const cwd=path.join(root,"other-launch-directory");fs.mkdirSync(cwd);
    const probe=path.join(root,"root-probe.ts");fs.writeFileSync(probe,`import { artifactAppDir,quarterAppDir } from ${JSON.stringify(path.join(repo,"src/lib/quarter/lease.ts"))}; delete process.env.FLOOR_BOARDS_TEST_ROOT; console.log(JSON.stringify({artifact:artifactAppDir(),lease:quarterAppDir()}));`);
    const check=await child(probe,cwd);expect(check.code).toBe(0);expect(check.output).toContain(JSON.stringify({artifact:repo,lease:repo}));
    const expectedPath=releaseLockPathFor(quarterAppDir());
    const before=await db.importBatch.count(),revision=await worldRevision(db);
    await withReleaseLease(async()=>{
      expect(fs.existsSync(expectedPath)).toBe(true);
      for(const script of ["scripts/quarter-migrate.ts","scripts/import-from-folder.ts"]){
        const result=await child(script,cwd,{FLOOR_BOARDS_IMPORT_DIR:cwd});expect(result.code).not.toBe(0);expect(result.output).toContain("RELEASE_BUSY");
      }
      expect(await db.importBatch.count()).toBe(before);expect(await worldRevision(db)).toBe(revision);
    },db);
  },40_000);
  it("legacy duplicate imports include original metadata and folder receipt replay is labeled accurately",async()=>{
    const csv=syntheticCsv([{employeeId:"imported",firstName:"Synthetic",lastName:"Fixture",position:"Caja - Regular",date,start:"1:00 pm",end:"2:00 pm"}]);
    const parsed=await parseSchedulesCsv(Buffer.from(csv));
    const batch=await db.importBatch.create({data:{filename:"original.csv",fingerprint:fingerprintFor(parsed),rowCount:1}});
    await activate();
    for(const operation of [()=>previewImport(parsed,{client:db}),()=>commitImport(parsed,"retry.csv",{client:db})]){
      await expect(operation()).rejects.toMatchObject({code:"DUPLICATE_LEGACY_RECEIPT_UNAVAILABLE",originalImport:{importBatchId:batch.id,filename:"original.csv",importedAt:batch.importedAt.toISOString(),rowCount:1,fingerprint:batch.fingerprint}});
    }
    expect(await db.shift.count()).toBe(0);await db.importBatch.delete({where:{id:batch.id}});
    const importDir=path.join(root,"exports");fs.mkdirSync(importDir);fs.writeFileSync(path.join(importDir,"Schedule_for_synthetic.csv"),csv);
    const settings={dir:importDir,mode:"apply" as const};
    const first=await runFolderImport(settings,{now:new Date(hour-3600000)});expect(first.outcome).toBe("imported");const revision=await worldRevision(db);
    const replay=await runFolderImport(settings,{now:new Date(hour-3600000)});expect(replay.outcome).toBe("replayed");expect(replay.dates).toEqual(first.dates);
    expect(formatSummary(replay)[0]).toContain("outcome=replayed");expect(EXIT_CODES[replay.outcome]).toBe(0);expect(startsNextWeek(replay)).toBe(true);expect(await worldRevision(db)).toBe(revision);
  });
});
