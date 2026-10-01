import {test,expect,type Page} from "@playwright/test";
import {createRequire} from "node:module";
import type {} from "./fixtures/quarter-storage";
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
