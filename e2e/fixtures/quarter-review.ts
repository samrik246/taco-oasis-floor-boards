import {DraftDatabase} from "@/lib/quarter/client/draft-db";
import {generation,newEnvelope,scopeKey,type DraftHead} from "@/lib/quarter/client/draft-types";
import {canonicalJson,sha256,randomId} from "@/lib/quarter/client/primitives";
import {v1Key} from "@/lib/quarter/client/v1-conversion";
const api={
 async seed(mode:"index"|"orphan"|"generation-digest"|"submission-digest"){
  const heads=await new Promise<DraftHead[]>((resolve,reject)=>{const r=indexedDB.open("taco-oasis-paint-drafts");r.onerror=()=>reject(r.error);r.onsuccess=()=>{const tx=r.result.transaction("heads"),q=tx.objectStore("heads").getAll();tx.oncomplete=()=>{r.result.close();resolve(q.result);};};});
  const scope=heads.find(h=>h.state==="outstanding")!;if(!scope)throw new Error("stage a real editor draft first");
  const db=await DraftDatabase.open();
  try{
   const before=await db.read(scope),g=before.generations.find(g=>g.generationId===scope.generationId)!;
   const submission=await db.prepare(scope,scope,"b".repeat(64));
   await db.retain(scope,scope,generation({managerId:scope.managerId,board:scope.board,date:scope.date},newEnvelope({...g.envelope,parentGenerationId:g.generationId,parentRevision:scope.localRevision})));
   const body={protocol:2,requestId:randomId(),capabilitySha256:"b".repeat(64),date:scope.date,expected:{databaseEpoch:g.envelope.databaseEpoch,worldRevision:g.envelope.baseWorldRevision},operation:"status",id:"review-only-task",status:"done"};
   const commandBytes=canonicalJson(body),key=`command:${scope.managerId}:${scope.board}:${scope.date}:tareas`;
   await db.retainCommand(key,{actionSha256:sha256("review-only-task"),requestBytes:commandBytes,requestSha256:sha256(commandBytes)});
   const original=' {"version":1,"original":"preserve this exact unconverted draft"} ';
   localStorage.setItem(v1Key(scope),original);
   await new Promise<void>((resolve,reject)=>{const r=indexedDB.open("taco-oasis-paint-drafts");r.onerror=()=>reject(r.error);r.onsuccess=()=>{
    const tx=r.result.transaction(["heads","v1Archives","generations","submissions"],"readwrite");
    tx.objectStore("v1Archives").add({managerId:scope.managerId,board:scope.board,date:scope.date,v1Sha256:sha256(original),original,observedAt:new Date().toISOString(),generationId:null,result:"review",staleReason:"SYNTHETIC"});
    if(mode==="orphan")tx.objectStore("heads").delete(scopeKey(scope));
    if(mode==="generation-digest")tx.objectStore("generations").put({...g,sha256:"0".repeat(64)});
    if(mode==="submission-digest")tx.objectStore("submissions").put({...submission,requestSha256:"0".repeat(64)});
    tx.oncomplete=()=>{r.result.close();resolve();};tx.onabort=()=>{r.result.close();reject(tx.error);};
   };});
   return {envelope:g.envelope,generationId:g.generationId,requestBytes:submission.requestBytes,commandBytes,original,legacyKey:v1Key(scope)};
  }finally{db.close();}
 }
};
declare global {interface Window{quarterReviewProof:typeof api;}}
window.quarterReviewProof=api;
