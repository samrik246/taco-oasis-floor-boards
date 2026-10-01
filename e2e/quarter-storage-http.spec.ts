import {test,expect,type Page} from "@playwright/test";
import {createRequire} from "node:module";
import type {} from "./fixtures/quarter-storage";
import {faultDraftIndexes} from "./fixtures/draft-storage-fault";
const requireBundle=createRequire(process.cwd()+"/package.json");
const {buildSync}=createRequire(requireBundle.resolve("tsx/package.json"))("esbuild") as {buildSync(options:Record<string,unknown>):{outputFiles:{text:string}[]}};
const bundle=buildSync({entryPoints:["e2e/fixtures/quarter-storage.ts"],bundle:true,write:false,platform:"browser",define:{"process.env.NODE_ENV":'"production"'}}).outputFiles[0].text;
const origin="http://floor-boards.test:3100";
async function load(page:Page){
 await page.goto(`${origin}/__quarter-storage-fixture`); // Real HTTP response from the fresh test server, with a non-loopback host.
 await page.addScriptTag({content:bundle});return page.evaluate(()=>window.quarterProof.open());
}
for(const hints of [true,false])test(`HTTP multi-tab CAS and retained branches without secure APIs; hints=${hints}`,async({context})=>{
 await context.addInitScript(({hints})=>{
  Object.defineProperty(crypto,"randomUUID",{value:undefined});Object.defineProperty(crypto,"subtle",{value:undefined});
  if(!hints)Object.defineProperty(window,"BroadcastChannel",{value:undefined});
 },{hints});
 const a=await context.newPage(),b=await context.newPage();
 for(const page of [a,b])expect(await load(page)).toEqual({secure:false,locks:"undefined",uuid:"undefined",subtle:"undefined",origin});
 const proposals=await Promise.all([a.evaluate(()=>window.quarterProof.prepareProposal("purple1")),b.evaluate(()=>window.quarterProof.prepareProposal("green1"))]);
 const results=await Promise.all([a.evaluate(()=>window.quarterProof.retain()),b.evaluate(()=>window.quarterProof.retain())]);
 expect(results.map(r=>r.status).sort()).toEqual(["conflict","retained"]);
 const snapshot=await a.evaluate(()=>window.quarterProof.read());expect(snapshot.generations).toHaveLength(2);expect(snapshot.head?.localRevision).toBe("1");
 expect(snapshot.generations.map(g=>g.sha256).sort()).toEqual(proposals.map(g=>g.sha256).sort());
 await a.evaluate(()=>window.quarterProof.close());await load(a);expect(await a.evaluate(()=>window.quarterProof.read())).toEqual(snapshot);
 const identities=await Promise.all([a.evaluate(()=>window.quarterProof.instance()),b.evaluate(()=>window.quarterProof.instance())]);expect(identities[0]).toBe(identities[1]);
 expect(await a.evaluate(()=>window.quarterProof.probe())).toBe("commit-readback-ok");expect(await a.evaluate(()=>window.quarterProof.durability)).toMatch(/strict|default/);
});
test("HTTP acknowledged receipt keeps newer intent and original expectations after reload",async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());
 const submission=await page.evaluate(()=>window.quarterProof.submit());
 const newer=await page.evaluate(()=>window.quarterProof.prepareProposal("green1"));await page.evaluate(()=>window.quarterProof.retain());
 expect((await page.evaluate(()=>window.quarterProof.submit())).requestBytes).toBe(submission.requestBytes);
 const result=await page.evaluate(s=>window.quarterProof.receipt(s),submission);expect(result.cleanupPending).toBe(false);
 const current=result.snapshot!.generations.find(g=>g.generationId===result.snapshot!.head!.generationId)!;
 expect(current.envelope.intents.map(i=>i.intentId)).toEqual(newer.envelope.intents.map(i=>i.intentId));
 expect(current.envelope.intents[0].hour).toEqual(newer.envelope.intents[0].hour);expect(current.envelope.reviewReasons).toContain("SAVED_COMMAND_CHANGED_EXPECTATIONS");
 expect(current.envelope.episodeId).not.toBe(submission.episodeId);
 await page.evaluate(()=>window.quarterProof.close());await load(page);expect(await page.evaluate(()=>window.quarterProof.read())).toEqual(result.snapshot);
});
test("HTTP cleanup abort honors success and reload reconciles original submission before discard",async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());
 const submission=await page.evaluate(()=>window.quarterProof.submit());
 await page.evaluate(()=>{
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore["put"]>){if(this.name==="submissions")this.transaction.abort();return original.apply(this,args);};
 });
 expect((await page.evaluate(s=>window.quarterProof.receipt(s),submission))).toMatchObject({saved:true,cleanupPending:true});
 const before=await page.evaluate(()=>window.quarterProof.read());expect(before.head?.pendingRequestId).toBe(submission.requestId);
 await page.evaluate(()=>window.quarterProof.close());await load(page);
 expect((await page.evaluate(s=>window.quarterProof.receipt(s),submission))).toMatchObject({saved:true,cleanupPending:false});
 const after=await page.evaluate(()=>window.quarterProof.read());expect(after.head?.state).toBe("closed");expect(after.submissions[0].state).toBe("confirmed");
 expect(after.generations.some(g=>g.generationId===submission.generationId)).toBe(true);
});
test("HTTP failed retention and failed discard leave prior committed bytes and work intact",async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());
 const before=await page.evaluate(()=>window.quarterProof.read());
 await page.evaluate(()=>{
  const original=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args:Parameters<IDBObjectStore["add"]>){if(this.name==="generations")throw new DOMException("Synthetic quota fault","QuotaExceededError");return original.apply(this,args);};
 });
 await page.evaluate(()=>window.quarterProof.prepareProposal("green1"));
 expect(await page.evaluate(()=>window.quarterProof.retain().then(()=>"unexpected",e=>e.name))).not.toBe("unexpected");
 expect(await page.evaluate(()=>window.quarterProof.read())).toEqual(before);
 expect(await page.evaluate(()=>window.quarterProof.discard().then(()=>"unexpected",e=>e.name))).not.toBe("unexpected");
 expect(await page.evaluate(()=>window.quarterProof.read())).toEqual(before);
});
test("HTTP unknown IDB version and unavailable storage preserve existing stores",async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());
 const before=await page.evaluate(()=>window.quarterProof.read());await page.evaluate(()=>window.quarterProof.close());
 await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const r=indexedDB.open("taco-oasis-paint-drafts",2);r.onsuccess=()=>{r.result.close();resolve();};r.onerror=()=>reject(r.error);}));
 expect(await page.evaluate(()=>window.quarterProof.open().then(()=>"unexpected",e=>e.message))).toBe("DRAFT_UNKNOWN_VERSION");
 const raw=await page.evaluate(()=>new Promise<unknown>((resolve,reject)=>{const r=indexedDB.open("taco-oasis-paint-drafts");r.onsuccess=()=>{const tx=r.result.transaction("generations"),get=tx.objectStore("generations").getAll();get.onsuccess=()=>resolve(get.result);tx.oncomplete=()=>r.result.close();};r.onerror=()=>reject(r.error);}));
 expect(raw).toEqual(before.generations);
 await page.evaluate(()=>Object.defineProperty(window,"indexedDB",{get(){throw new DOMException("Synthetic denial","SecurityError");}}));
 expect(await page.evaluate(()=>window.quarterProof.open().then(()=>"unexpected",e=>e.message))).toBe("DRAFT_STORAGE_UNAVAILABLE");
});

test("HTTP V1 archive/tombstone deduplication never rewrites an old tab's draft",async({page})=>{
 await load(page);
 const day={schemaVersion:2 as const,databaseEpoch:"synthetic-epoch",worldRevision:"0",phase:"prepared" as const,capabilitySha256:"a".repeat(64),board:"caja" as const,date:"2038-10-12",
  employees:[{id:"person",firstName:"Synthetic",lastName:"Person"}],stations:[{id:"purple1",label:"P1",color:"purple",sortOrder:1,maxConcurrent:1,shortCode:"P1"}],
  sources:[{shiftId:"source",employeeId:"person",board:"caja" as const,date:"2038-10-12",sourcePosition:"Caja",startAt:"2038-10-12T16:00:00.000Z",endAt:"2038-10-12T17:00:00.000Z",supersededAt:null,boardRemoved:false}],
  hours:[{shiftId:"source",hourStart:"2038-10-12T16:00:00.000Z",revision:null,legacySha256:"a".repeat(64),intervals:[{startAt:"2038-10-12T16:00:00.000Z",endAt:"2038-10-12T17:00:00.000Z",state:"erased" as const,stationId:null,seatNumber:null,provenance:{kind:"legacy" as const,assignmentId:null}}]}],coverDisplay:{version:1 as const,tracks:[],unavailable:[]}};
 const {startAt,endAt,employeeId,sourcePosition}=day.sources[0];
 const raw=JSON.stringify({version:1,updatedAt:"2038-10-11T00:00:00.000Z",edits:[{shiftId:"source",hour:11,stationId:"purple1",expected:null,expectedShift:{startAt,endAt,employeeId,sourcePosition}}]});
 const migrated=await page.evaluate(({raw,day})=>window.quarterProof.v1(raw,day),{raw,day});
 expect(migrated.snapshot.archives[0].original).toBe(raw);expect(migrated.snapshot.generations[0].envelope.intents).toHaveLength(4);expect(migrated.snapshot.generations[0].envelope.firstDirtyAt).toBeNull();
 await page.evaluate(()=>window.quarterProof.discard());
 const closed=await page.evaluate(()=>window.quarterProof.read());expect(closed.head?.state).toBe("closed");
 const repeated=await page.evaluate(({raw,day})=>window.quarterProof.v1(raw,day),{raw,day});expect(repeated.snapshot).toEqual(closed);
 const changed=raw.replace('"stationId":"purple1"','"stationId":"green1"');
 const another=await page.evaluate(({raw,day})=>window.quarterProof.v1(raw,day),{raw:changed,day});
 expect(another.snapshot.head).toEqual(closed.head);expect(another.snapshot.archives.map(a=>a.original).sort()).toEqual([raw,changed].sort());
 expect(another.snapshot.generations.filter(g=>g.disposition==="conflict-branch")).toHaveLength(1);
 expect(await page.evaluate(()=>localStorage.getItem("taco-oasis-paint-draft-v1:synthetic-manager:caja:2038-10-12"))).toBe(changed);
});

test("HTTP versionchange closes the bridge while blocked upgrade preserves all data",async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());
 const before=await page.evaluate(()=>window.quarterProof.read());
 const blocked=await page.evaluate(()=>new Promise<string>((resolve,reject)=>{
  const blocker=indexedDB.open("taco-oasis-paint-drafts",1);
  blocker.onsuccess=()=>{
   const upgrade=indexedDB.open("taco-oasis-paint-drafts",2);
   upgrade.onblocked=()=>{blocker.result.close();resolve("blocked-observed");};
   upgrade.onsuccess=()=>upgrade.result.close();upgrade.onerror=()=>reject(upgrade.error);
  };blocker.onerror=()=>reject(blocker.error);
 }));
 expect(blocked).toBe("blocked-observed");
 expect(await page.evaluate(()=>window.quarterProof.read().then(()=>"unexpected",e=>e.message))).toBe("DRAFT_CONNECTION_CLOSED");
 const preserved=await page.evaluate(()=>new Promise<unknown>((resolve,reject)=>{
  const r=indexedDB.open("taco-oasis-paint-drafts");r.onsuccess=()=>{const tx=r.result.transaction("generations"),q=tx.objectStore("generations").getAll();q.onsuccess=()=>resolve(q.result);tx.oncomplete=()=>r.result.close();};r.onerror=()=>reject(r.error);
 }));expect(preserved).toEqual(before.generations);
});

for(const field of ["intent","unknown","head"])test(`HTTP malformed ${field} remains preserved and refuses edits`,async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());
 await page.evaluate(field=>window.quarterProof.corrupt(field),field);
 expect((await page.evaluate(()=>window.quarterProof.read())).warnings.length).toBeGreaterThan(0);
 await page.evaluate(()=>window.quarterProof.prepareProposal("green1"));
 expect(await page.evaluate(()=>window.quarterProof.retain().then(()=>"unexpected",e=>e.message))).toBe("DRAFT_REQUIRES_REVIEW");
 expect(await page.evaluate(()=>window.quarterProof.submit().then(()=>"unexpected",e=>e.message))).toBe("DRAFT_REQUIRES_REVIEW");
});

async function rawDatabase(page:Page){
 return page.evaluate(()=>new Promise<unknown>((resolve,reject)=>{
  const r=indexedDB.open("taco-oasis-paint-drafts");r.onerror=()=>reject(r.error);r.onsuccess=()=>{
   const db=r.result,names=[...db.objectStoreNames],tx=db.transaction(names),result:Record<string,unknown>={};
   for(const name of names){const store=tx.objectStore(name),read=store.getAll();read.onsuccess=()=>{result[name]={keyPath:store.keyPath,autoIncrement:store.autoIncrement,indices:[...store.indexNames].map(name=>{const i=store.index(name);return {name,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry};}),rows:read.result};};}
   tx.oncomplete=()=>{db.close();resolve(result);};tx.onabort=()=>reject(tx.error);
  };
 }));
}
for(const mode of ["heads-key","generations-key","v1Archives-key","submissions-key","clientMeta-key","missing-store","extra-store","auto-increment","missing-index","index-key","index-unique","index-multiEntry"]){
 test(`HTTP incompatible IDB ${mode} refuses before writes and preserves raw state`,async({page})=>{
  await page.goto(`${origin}/__quarter-storage-fixture`);await page.addScriptTag({content:bundle});
  await page.evaluate(mode=>new Promise<void>((resolve,reject)=>{
   const r=indexedDB.open("taco-oasis-paint-drafts",1);r.onerror=()=>reject(r.error);
   r.onupgradeneeded=()=>{
    const names=["heads","generations","submissions","v1Archives","clientMeta",...(mode==="extra-store"?["future"]:[])];
    for(const name of names){
     if(mode==="missing-store"&&name==="clientMeta")continue;
     let keyPath:string|string[]=name==="clientMeta"||name==="future"?"key":name==="submissions"?["managerId","requestId"]:["managerId","board","date",...(name==="heads"?[]:[name==="generations"?"generationId":"v1Sha256"])];
     if(mode===`${name}-key`)keyPath=name==="clientMeta"?"future":"managerId";
     const autoIncrement=mode==="auto-increment"&&name==="clientMeta";
     const store=r.result.createObjectStore(name,{keyPath,autoIncrement});
     if(name!=="clientMeta"&&name!=="future"&&!(mode==="missing-index"&&name==="heads")){
      const index=name==="heads"?"manager":"scope";
      let indexKey:string|string[]=name==="heads"?"managerId":["managerId","board","date"];
      if(mode==="index-key"&&name==="heads")indexKey="date";
      store.createIndex(index,indexKey,{unique:mode==="index-unique"&&name==="heads",multiEntry:mode==="index-multiEntry"&&name==="heads"});
     }
     store.add({managerId:"preserved-owner",board:"caja",date:"2038-10-11",generationId:"retained",requestId:"retained",v1Sha256:"retained",key:"retained",future:"retained",original:"Do not overwrite this record"});
    }
   };r.onsuccess=()=>{r.result.close();resolve();};
  }),mode);
  const before=await rawDatabase(page);
  if(["missing-index","index-key","index-unique","index-multiEntry"].includes(mode)){
   await page.evaluate(()=>window.quarterProof.open());expect(await page.evaluate(()=>window.quarterProof.readOnly)).toBe(true);
   expect(await page.evaluate(()=>window.quarterProof.probe().then(()=>"unexpected",e=>e.message))).toBe("DRAFT_READ_ONLY_REVIEW");
  }else expect(await page.evaluate(()=>window.quarterProof.open().then(()=>"unexpected",e=>e.message))).toBe("DRAFT_SCHEMA_REQUIRES_REVIEW");
  expect(await rawDatabase(page)).toEqual(before);
 });
}
for(const mode of ["wrapper","metadata","body","scope"])test(`HTTP incompatible retained command ${mode} refuses replacement and preserves bytes`,async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.retainCommand());await page.evaluate(mode=>window.quarterProof.corruptCommand(mode),mode);
 const before=await rawDatabase(page);
 expect(await page.evaluate(()=>window.quarterProof.retainCommand().then(()=>"unexpected",e=>e.message))).toBe("COMMAND_REQUIRES_REVIEW");
 expect(await page.evaluate(()=>window.quarterProof.pendingCommands().then(()=>"unexpected",e=>e.message))).toBe("COMMAND_REQUIRES_REVIEW");
 expect(await rawDatabase(page)).toEqual(before);
});

for(const mode of ["missing","wrong","unique","multiEntry","extra"] as const)test(`HTTP ${mode} indexes expose cursor review without writes, retries or activation`,async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());
 const submission=await page.evaluate(()=>window.quarterProof.submit()),command=await page.evaluate(()=>window.quarterProof.retainCommand());
 const raw=' {"version":1,"retained":"untouched original"} ';
 await page.evaluate(raw=>window.quarterProof.archive(raw),raw);
 const before=await page.evaluate(()=>window.quarterProof.read());expect(before.generations).toHaveLength(1);
 await page.evaluate(()=>window.quarterProof.close());await faultDraftIndexes(page,mode);
 const original=await rawDatabase(page);await page.evaluate(()=>window.quarterProof.open());
 const apiRequests:string[]=[];page.on("request",request=>{if(request.url().includes("/api/"))apiRequests.push(request.url());});
 await page.evaluate(()=>{
  const getAll=IDBObjectStore.prototype.getAll,transaction=IDBDatabase.prototype.transaction;
  const proof={writes:0,cursors:[] as string[]},cursor=IDBObjectStore.prototype.openCursor;
  IDBObjectStore.prototype.openCursor=function(...args:Parameters<IDBObjectStore["openCursor"]>){proof.cursors.push(this.name);return cursor.apply(this,args);};
  IDBObjectStore.prototype.getAll=function(...args:Parameters<IDBObjectStore["getAll"]>){if(this.name!=="clientMeta")throw new Error("review must enumerate cursors");return getAll.apply(this,args);};
  IDBDatabase.prototype.transaction=function(...args:Parameters<IDBDatabase["transaction"]>){if(args[1]==="readwrite")proof.writes++;return transaction.apply(this,args);};
  Object.assign(window,{reviewProof:proof,restoreReviewProof:()=>{IDBObjectStore.prototype.getAll=getAll;IDBObjectStore.prototype.openCursor=cursor;IDBDatabase.prototype.transaction=transaction;}});
 });
 const review=await page.evaluate(()=>window.quarterProof.read());expect(review.warnings.join()).toContain("DRAFT_INDEX_REQUIRES_REVIEW");
 expect({...review,warnings:[]}).toEqual(before);expect(await page.evaluate(()=>window.quarterProof.dates())).toEqual(["2038-10-12"]);
 expect((await page.evaluate(()=>window.quarterProof.pendingCommands()))[0].value.requestBytes).toBe(command.requestBytes);
 const refused=await page.evaluate(async({submission,bytes,raw})=>{
  const api=window.quarterProof,errors:string[]=[];
  const attempts=[()=>api.retain(),()=>api.submit(),()=>api.receipt(submission),()=>api.reject(submission),()=>api.discard(),()=>api.retainCommand(),()=>api.finishCommand(bytes,"confirmed",{ok:true}),()=>api.instance(),()=>api.probe(),()=>api.resume(),()=>api.send(submission),()=>api.measure()];
  for(const attempt of attempts)try{await attempt();errors.push("unexpected");}catch(e){errors.push((e as Error).message);}
  const observed=await api.v1(raw,{} as Parameters<typeof api.v1>[1]);
  return {errors,observed,legacy:localStorage.getItem("taco-oasis-paint-draft-v1:synthetic-manager:caja:2038-10-12")};
 },{submission,bytes:command.requestBytes,raw});
 expect(refused.errors).toHaveLength(12);for(const error of refused.errors)expect(error).toMatch(/DRAFT_(READ_ONLY_REVIEW|REQUIRES_REVIEW)/);
 expect(refused.observed.snapshot).toEqual(review);expect(refused.legacy).toBe(raw);
 const proof=await page.evaluate(()=>{const w=window as unknown as {reviewProof:{writes:number;cursors:string[]};restoreReviewProof:()=>void};w.restoreReviewProof();return w.reviewProof;});
 expect(proof.writes).toBe(0);expect(new Set(proof.cursors)).toEqual(new Set(["heads","generations","submissions","v1Archives","clientMeta"]));
 expect(apiRequests).toEqual([]);
 expect(await rawDatabase(page)).toEqual(original);
 await page.evaluate(()=>window.quarterProof.close());await load(page);expect(await page.evaluate(()=>window.quarterProof.read())).toEqual(review);
 expect(await rawDatabase(page)).toEqual(original);
});

for(const mode of ["generation","submission","archive","broken"] as const)test(`HTTP ${mode} orphan scope stays discoverable without reconstructing a head`,async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());await page.evaluate(()=>window.quarterProof.submit());
 await page.evaluate(mode=>window.quarterProof.orphan(mode),mode);
 const before=await rawDatabase(page),snapshot=await page.evaluate(()=>window.quarterProof.read());
 expect(snapshot.head).toBeNull();expect(snapshot.warnings).toContain("DRAFT_HEAD_MISSING_REQUIRES_REVIEW");
 expect(await page.evaluate(()=>window.quarterProof.dates())).toEqual(["2038-10-12"]);
 await page.evaluate(()=>window.quarterProof.prepareProposal("green1"));
 expect(await page.evaluate(()=>window.quarterProof.retain().then(()=>"unexpected",e=>e.message))).toBe("DRAFT_REQUIRES_REVIEW");
 await page.evaluate(()=>window.quarterProof.close());await load(page);
 expect(await page.evaluate(()=>window.quarterProof.read())).toEqual(snapshot);expect(await rawDatabase(page)).toEqual(before);
});

test("HTTP closed head keeps retained ordinary history out of outstanding dates",async({page})=>{
 await load(page);await page.evaluate(()=>window.quarterProof.prepareProposal("purple1"));await page.evaluate(()=>window.quarterProof.retain());await page.evaluate(()=>window.quarterProof.discard());
 expect((await page.evaluate(()=>window.quarterProof.read())).generations).toHaveLength(2);
 expect(await page.evaluate(()=>window.quarterProof.dates())).toEqual([]);
 await page.evaluate(()=>window.quarterProof.close());await faultDraftIndexes(page,"missing");await page.evaluate(()=>window.quarterProof.open());
 expect(await page.evaluate(()=>window.quarterProof.dates())).toEqual([]);
});
test("HTTP terminal command outcome is immutable across a delayed conflicting completion",async({page})=>{
 await load(page);const command=await page.evaluate(()=>window.quarterProof.retainCommand());
 await page.evaluate(bytes=>window.quarterProof.finishCommand(bytes,"confirmed",{ok:true,original:true}),command.requestBytes);
 const before=await rawDatabase(page);
 expect(await page.evaluate(bytes=>window.quarterProof.finishCommand(bytes,"rejected",{code:"LATE_REJECTION"}).then(()=>"unexpected",e=>e.message),command.requestBytes)).toBe("COMMAND_OUTCOME_CHANGED");
 expect(await rawDatabase(page)).toEqual(before);
});
