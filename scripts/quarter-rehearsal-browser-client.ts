/** Bundled into a real ordinary-HTTP browser by the synthetic recovery harness. */
import {chicagoHourStart} from "../src/lib/hour-grid";
import {DraftDatabase,activeGeneration,emptyBase} from "../src/lib/quarter/client/draft-db";
import {generation,newEnvelope,type DraftScope} from "../src/lib/quarter/client/draft-types";
import {randomId,canonicalJson} from "../src/lib/quarter/client/primitives";
import {sendSubmission} from "../src/lib/quarter/client/transport";
import {publicDaySchema,saveBoardV2} from "../src/lib/quarter/client/day";
import {observeV1,v1Key} from "../src/lib/quarter/client/v1-conversion";
const api={
 async seed(date:string,shiftId:string){
  const login=await fetch("/api/managers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"quarter-rehearsal-owner"})});
  const auth=await login.json();if(!login.ok)throw new Error("REHEARSAL_LOGIN_FAILED");
  const scope:DraftScope={managerId:auth.manager.id,board:"caja",date},db=await DraftDatabase.open();
  try{
   const response=await fetch(`/api/v2/boards/caja/days/${date}`,{headers:{"x-manager-session":auth.sessionToken}});
   if(!response.ok)throw new Error("REHEARSAL_DAY_FAILED");const day=publicDaySchema.parse(await response.json());
   const source=day.sources.find(s=>s.shiftId===shiftId)!,hour=day.hours.find(h=>h.shiftId===shiftId&&h.hourStart===chicagoHourStart(date,10).toISOString())!;
   if(!source||!hour)throw new Error("REHEARSAL_SOURCE_MISSING");
   const now=new Date().toISOString(),base=emptyBase;
   const row={intentId:randomId(),editedAt:now,source,hour:hour.revision===null?{shiftId,hourStart:hour.hourStart,revision:null,legacySha256:hour.legacySha256!}:{shiftId,hourStart:hour.hourStart,revision:hour.revision},baseWorldRevision:day.worldRevision!,intent:{shiftId,quarter:"10:00",granularity:"quarter" as const,action:"station" as const,stationId:"green1"}};
   const proposal=generation(scope,newEnvelope({databaseEpoch:day.databaseEpoch!,parentGenerationId:base.generationId,parentRevision:base.localRevision,episodeId:randomId(),firstDirtyAt:now,firstObservedAt:now,timeProvenance:"edited",baseWorldRevision:day.worldRevision!,intents:[row],pendingRequestId:null,migratedFromV1Sha256:null,reviewReasons:[]}));
   const stored=await db.retain(scope,base,proposal),submission=await db.prepare(scope,stored.snapshot.head!,day.capabilitySha256);
   const prepared=await db.read(scope),current=activeGeneration(prepared)!;
   const newer={...row,intentId:randomId(),editedAt:new Date().toISOString(),intent:{...row.intent,quarter:"10:30",stationId:"purple1"}};
   const residual=generation(scope,newEnvelope({...current.envelope,parentGenerationId:current.generationId,parentRevision:prepared.head!.localRevision,intents:[...current.envelope.intents,newer],pendingRequestId:submission.requestId}));
   await db.retain(scope,prepared.head!,residual);
   const archivedScope={...scope,managerId:"synthetic-archived-owner"};
   localStorage.setItem(v1Key(archivedScope),"{retained-synthetic-v1");await observeV1(db,archivedScope,day);
   if(!saveBoardV2(day,new Date(`${date}T17:00:00.000Z`)))throw new Error("REHEARSAL_CACHE_NOT_RETAINED");
   await db.clientInstance();
   const outcome=await sendSubmission(db,scope,submission,auth.sessionToken);
   if(outcome.status!=="unconfirmed")throw new Error("REHEARSAL_RESPONSE_NOT_LOST");
   return {scope,submission,newerIntentId:newer.intentId,secure:isSecureContext,locks:typeof navigator.locks};
  }finally{db.close();}
 },
 async reconcile(scope:DraftScope){
  const login=await fetch("/api/managers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"quarter-rehearsal-owner"})});
  const auth=await login.json();if(!login.ok)throw new Error("REHEARSAL_LOGIN_FAILED");
  const db=await DraftDatabase.open();try{
   const before=await db.read(scope),submission=before.submissions.find(s=>s.requestId===before.head?.pendingRequestId)!;
   if(!submission)throw new Error("REHEARSAL_PENDING_MISSING");
   const result=await sendSubmission(db,scope,submission,auth.sessionToken,true);
   if(result.status!=="saved")throw new Error("REHEARSAL_RECEIPT_NOT_RECONCILED");
   const replay=await sendSubmission(db,scope,submission,auth.sessionToken);
   if(replay.status!=="saved"||canonicalJson(replay.receipt)!==canonicalJson(result.receipt))throw new Error("REHEARSAL_REPLAY_CHANGED");
   const after=await db.read(scope),remaining=activeGeneration(after)!;
   if(remaining.envelope.intents.length!==1||submission.submittedIntentIds.includes(remaining.envelope.intents[0].intentId)||remaining.envelope.episodeId===submission.episodeId||!remaining.envelope.reviewReasons.includes("SAVED_COMMAND_CHANGED_EXPECTATIONS"))throw new Error("REHEARSAL_NEWER_DRAFT_LOST");
   return {before,after,receipt:result.receipt};
  }finally{db.close();}
 },
 async dump(){
  const stores=await new Promise<Record<string,unknown[]>>((resolve,reject)=>{
   const request=indexedDB.open("taco-oasis-paint-drafts",1);request.onerror=()=>reject(request.error);
   request.onsuccess=()=>{const db=request.result,names=Array.from(db.objectStoreNames),tx=db.transaction(names),rows:Record<string,unknown[]>={};
    for(const name of names){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{rows[name]=r.result;};}
    tx.oncomplete=()=>{db.close();resolve(rows);};tx.onabort=()=>reject(tx.error);
   };
  });
  const local=Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith("taco-oasis-paint-draft-v1:")||k==="taco-oasis-last-board-v2").sort().map(k=>[k,localStorage.getItem(k)]));
  return {stores,local};
 }
};
declare global{interface Window{quarterRecovery:typeof api;}}
window.quarterRecovery=api;
