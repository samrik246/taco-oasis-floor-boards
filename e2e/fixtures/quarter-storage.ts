import {DraftDatabase,activeGeneration,conflictBranches,emptyBase} from "@/lib/quarter/client/draft-db";
import {generation,newEnvelope,scopeKey,type DraftGeneration,type DraftScope,type DraftSubmission} from "@/lib/quarter/client/draft-types";
import {randomId,contentHash,canonicalJson,sha256} from "@/lib/quarter/client/primitives";
import type {PaintReceipt} from "@/lib/quarter/transaction";
import {observeV1,v1Key} from "@/lib/quarter/client/v1-conversion";
import type {PublicDayV2} from "@/lib/quarter/client/day";
import {resumeAction} from "@/lib/quarter/client/controls";
import {sendSubmission} from "@/lib/quarter/client/transport";
import {measureClient} from "@/lib/quarter/client/readback";
const scope:DraftScope={managerId:"synthetic-manager",board:"caja",date:"2038-10-12"};
const at="2038-10-12T16:00:00.000Z";
const commandKey=`command:${scope.managerId}:${scope.board}:${scope.date}:tareas`;
let db:DraftDatabase|null=null,proposal:DraftGeneration|null=null;
const api={
 async open(){db=await DraftDatabase.open();return {secure:isSecureContext,locks:typeof navigator.locks,uuid:typeof crypto.randomUUID,subtle:typeof crypto.subtle,origin:location.origin};},
 async prepareProposal(stationId:string){
  const snapshot=await db!.read(scope),head=snapshot.head??emptyBase,current=activeGeneration(snapshot),now=new Date().toISOString();
  const row={intentId:randomId(),editedAt:now,intent:{action:"station" as const,stationId,shiftId:"source",quarter:"11:00",granularity:"hour" as const},
   source:{shiftId:"source",employeeId:"person",date:scope.date,board:"caja" as const,sourcePosition:"Caja",startAt:at,endAt:"2038-10-12T17:00:00.000Z",supersededAt:null,boardRemoved:false},
   hour:{shiftId:"source",hourStart:at,revision:null,legacySha256:"a".repeat(64)},baseWorldRevision:"0"};
  proposal=generation(scope,newEnvelope({databaseEpoch:"synthetic-epoch",parentGenerationId:head.generationId,parentRevision:head.localRevision,
   episodeId:current?.envelope.episodeId??randomId(),firstDirtyAt:current?.envelope.firstDirtyAt??now,firstObservedAt:current?.envelope.firstObservedAt??now,
   timeProvenance:"edited",baseWorldRevision:"0",intents:[row],pendingRequestId:snapshot.head?.pendingRequestId??null,migratedFromV1Sha256:null,reviewReasons:[]}));
  return proposal;
 },
 async retain(){return db!.retain(scope,{generationId:proposal!.envelope.parentGenerationId,localRevision:proposal!.envelope.parentRevision},proposal!);},
 async prepareSelection(branchId:string){
  const snapshot=await db!.read(scope),current=activeGeneration(snapshot)!;
  proposal=generation(scope,newEnvelope({...current.envelope,parentGenerationId:snapshot.head!.generationId,parentRevision:snapshot.head!.localRevision,pendingRequestId:null}),[branchId]);
  return proposal;
 },
 async branches(){return conflictBranches(await db!.read(scope)).map(g=>g.generationId).sort();},
 read(){return db!.read(scope);},dates(){return db!.dates(scope.managerId,scope.board);},
 get readOnly(){return db!.readOnly;},
 resume(){return resumeAction(scope,commandKey,"synthetic-review-token");},
 send(submission:DraftSubmission){return sendSubmission(db!,scope,submission,"synthetic-review-token");},
 reject(submission:DraftSubmission){return db!.reject(scope,submission,"SYNTHETIC");},
 measure(){return measureClient({challengeId:"synthetic",databaseEpoch:"synthetic-epoch",schemaFingerprint:"synthetic"},"editor","caja");},
 async submit(){const s=await db!.read(scope);return db!.prepare(scope,s.head!,"b".repeat(64));},
 async receipt(submission:DraftSubmission,wrongBinding=false){const receipt:PaintReceipt={ok:true,requestId:submission.requestId,requestSha256:wrongBinding?"0".repeat(64):submission.requestSha256,databaseEpoch:submission.databaseEpoch,
  draftSubmission:{episodeId:submission.episodeId,generationId:submission.generationId,generationSha256:submission.generationSha256},dates:[scope.date],committedRevision:"12",hours:[],refreshRequired:true};
  return db!.applyReceipt(scope,submission,receipt);
 },
 async discard(){const s=await db!.read(scope);return db!.discard(scope,s.head!);},
 async orphan(mode:"generation"|"submission"|"archive"|"broken"){
  const s=await db!.read(scope),raw='{"retained":"exact old bytes"}';
  await new Promise<void>((resolve,reject)=>{
   const r=indexedDB.open("taco-oasis-paint-drafts");r.onerror=()=>reject(r.error);r.onsuccess=()=>{
    const tx=r.result.transaction(["heads","generations","submissions","v1Archives"],"readwrite");
    if(mode==="broken")tx.objectStore("heads").put({...s.head,localRevision:"broken"});else tx.objectStore("heads").clear();
    if(mode==="submission"||mode==="archive")tx.objectStore("generations").clear();
    if(mode==="archive"){
     tx.objectStore("submissions").clear();tx.objectStore("v1Archives").add({...scope,v1Sha256:sha256(raw),original:raw,observedAt:new Date().toISOString(),generationId:null,result:"review",staleReason:"SYNTHETIC"});
    }
    tx.oncomplete=()=>{r.result.close();resolve();};tx.onabort=()=>{r.result.close();reject(tx.error);};
   };
  });
 },
 async v1(raw:string,day:PublicDayV2){localStorage.setItem(v1Key(scope),raw);return observeV1(db!,scope,day);},
 async archive(raw:string){
  await new Promise<void>((resolve,reject)=>{const r=indexedDB.open("taco-oasis-paint-drafts");r.onerror=()=>reject(r.error);r.onsuccess=()=>{
   const tx=r.result.transaction(["v1Archives","generations"],"readwrite");
   tx.objectStore("v1Archives").add({...scope,v1Sha256:sha256(raw),original:raw,observedAt:new Date().toISOString(),generationId:null,result:"review",staleReason:"SYNTHETIC"});
   const g=tx.objectStore("generations").get([...scopeKey(scope),proposal!.generationId]);
   g.onsuccess=()=>{if(g.result)tx.objectStore("generations").add({...g.result,managerId:"other-manager"});};
   tx.oncomplete=()=>{r.result.close();resolve();};tx.onabort=()=>{r.result.close();reject(tx.error);};
  };});
 },
 async corrupt(field:string){
  const s=await db!.read(scope),g=structuredClone(s.generations[0]);
  if(field==="intent")g.envelope.intents[0].intent.quarter="25:00";
  if(field==="unknown")Object.assign(g.envelope,{futureField:true});
  g.sha256=contentHash(g.envelope);
  await new Promise<void>((resolve,reject)=>{const r=indexedDB.open("taco-oasis-paint-drafts");r.onsuccess=()=>{const tx=r.result.transaction(["heads","generations"],"readwrite");if(field==="head")tx.objectStore("heads").put({...s.head,localRevision:"unknown"});else tx.objectStore("generations").put(g);tx.oncomplete=()=>{r.result.close();resolve();};tx.onabort=()=>reject(tx.error);};r.onerror=()=>reject(r.error);});
 },
 async retainCommand(){
  const body={protocol:2,requestId:randomId(),capabilitySha256:"a".repeat(64),date:scope.date,expected:{databaseEpoch:"synthetic-epoch",worldRevision:"0"},operation:"status",id:"task",status:"done"};
  const bytes=canonicalJson(body);return db!.retainCommand(commandKey,{actionSha256:contentHash({operation:"status",id:"task",status:"done"}),requestBytes:bytes,requestSha256:sha256(bytes)});
 },
 finishCommand(bytes:string,state:"confirmed"|"rejected",response:unknown){return db!.finishCommand(commandKey,bytes,state,response);},
 pendingCommands(){return db!.pendingCommands(scope);},
 async corruptCommand(mode:string){
  await new Promise<void>((resolve,reject)=>{const r=indexedDB.open("taco-oasis-paint-drafts");r.onsuccess=()=>{
   const tx=r.result.transaction("clientMeta","readwrite"),store=tx.objectStore("clientMeta"),read=store.get(commandKey);
   read.onsuccess=()=>{const row=read.result;
    if(mode==="wrapper")row.future=true;
    else if(mode==="metadata")row.value.future=true;
    else {const body=JSON.parse(row.value.requestBytes);if(mode==="scope")body.date="2038-10-13";else body.future=true;row.value.requestBytes=canonicalJson(body);row.value.requestSha256=sha256(row.value.requestBytes);}
    store.put(row);
   };tx.oncomplete=()=>{r.result.close();resolve();};tx.onabort=()=>reject(tx.error);
  };r.onerror=()=>reject(r.error);});
 },
 instance(){return db!.clientInstance();},probe(){return db!.probe();},close(){db!.close();db=null;},
 get durability(){return db?.durability;},
};
declare global {interface Window{quarterProof:typeof api;}}
window.quarterProof=api;
