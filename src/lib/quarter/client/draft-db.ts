import type { PaintReceipt } from "../transaction";
import { canonicalJson, contentHash, randomId, sha256 } from "./primitives";
import {
  assertGeneration, assertReceipt, commandFor, DraftError, emptyBase, generation, newEnvelope,
  sameBase, sameScope, scopeKey, submissionFor,
  type DraftBase, type DraftGeneration, type DraftHead, type DraftScope, type DraftSnapshot,
  type DraftSubmission, type V1Archive,
} from "./draft-types";

export const DRAFT_DATABASE = "taco-oasis-paint-drafts";
export const DRAFT_DATABASE_VERSION = 1;
export const DRAFT_STORES = ["heads","generations","submissions","v1Archives","clientMeta"] as const;
type Store = typeof DRAFT_STORES[number];
type Meta = { key:string; value:unknown };

/** IDB callbacks are synchronous. Completion, never request success, is the commit boundary. */
export class DraftDatabase {
  private changing = false;
  durability: "strict" | "default" = "default";
  private constructor(private db: IDBDatabase, private onState: (state:string)=>void) {
    db.onversionchange = () => { this.changing=true; onState("DRAFT_UPGRADE_REQUIRES_REVIEW"); db.close(); };
    db.onclose = () => { this.changing=true; onState("DRAFT_CONNECTION_CLOSED"); };
  }
  static open(onState: (state:string)=>void = ()=>{}): Promise<DraftDatabase> {
    return new Promise((resolve,reject)=>{
      let request: IDBOpenDBRequest, settled=false;
      const fail = (code:string) => { settled=true; onState(code); reject(new DraftError(code)); };
      try { request=indexedDB.open(DRAFT_DATABASE,DRAFT_DATABASE_VERSION); }
      catch { fail("DRAFT_STORAGE_UNAVAILABLE"); return; }
      request.onblocked=()=>fail("DRAFT_UPGRADE_BLOCKED");
      request.onerror=()=>fail(request.error?.name==="VersionError"?"DRAFT_UNKNOWN_VERSION":"DRAFT_STORAGE_UNAVAILABLE");
      request.onupgradeneeded=event=>{
        if (event.oldVersion!==0) { request.transaction!.abort(); return; }
        const db=request.result;
        const heads=db.createObjectStore("heads",{keyPath:["managerId","board","date"]});
        heads.createIndex("manager","managerId");
        for (const [name,key] of [["generations","generationId"],["v1Archives","v1Sha256"]] as const) {
          const store=db.createObjectStore(name,{keyPath:["managerId","board","date",key]});
          store.createIndex("scope",["managerId","board","date"]);
        }
        const submissions=db.createObjectStore("submissions",{keyPath:["managerId","requestId"]});
        submissions.createIndex("scope",["managerId","board","date"]);
        db.createObjectStore("clientMeta",{keyPath:"key"});
      };
      request.onsuccess=()=>{
        if(settled){request.result.close();return;}
        if(DRAFT_STORES.some(s=>!request.result.objectStoreNames.contains(s))){request.result.close();fail("DRAFT_SCHEMA_REQUIRES_REVIEW");return;}
        settled=true;resolve(new DraftDatabase(request.result,onState));
      };
    });
  }
  close() { this.changing=true; this.db.close(); }
  private transaction<T>(names: readonly Store[], mode: IDBTransactionMode,
    run:(tx:IDBTransaction, finish:(value:T)=>void, fail:(error:Error)=>void)=>void):Promise<T> {
    if(this.changing)return Promise.reject(new DraftError("DRAFT_CONNECTION_CLOSED"));
    return new Promise((resolve,reject)=>{
      let tx:IDBTransaction, value:T, hasValue=false, error:Error|null=null;
      try {
        if(mode==="readwrite") {
          try { tx=this.db.transaction([...names],mode,{durability:"strict"});this.durability=tx.durability==="strict"?"strict":"default"; }
          catch(e) { if(!(e instanceof TypeError))throw e;tx=this.db.transaction([...names],mode);this.durability="default"; }
        } else tx=this.db.transaction([...names],mode);
      } catch(e) { reject(e);return; }
      const fail=(e:Error)=>{error=e;try{tx.abort();}catch{/* transaction already aborting */}};
      tx.onabort=()=>reject(error??tx.error??new DraftError("DRAFT_TRANSACTION_ABORTED"));
      tx.onerror=()=>{error??=tx.error;};
      tx.oncomplete=()=>hasValue?resolve(value):reject(new DraftError("DRAFT_TRANSACTION_INCOMPLETE"));
      try { run(tx,v=>{value=v;hasValue=true;},fail); } catch(e) { fail(e as Error); }
    });
  }
  async read(scope:DraftScope):Promise<DraftSnapshot> {
    const snapshot=await this.transaction<DraftSnapshot>(["heads","generations","submissions","v1Archives"],"readonly",(tx,finish)=>{
      const result:DraftSnapshot={head:null,generations:[],submissions:[],archives:[],warnings:[]};
      const head=tx.objectStore("heads").get(scopeKey(scope));head.onsuccess=()=>{result.head=head.result??null;};
      for(const [name,key] of [["generations","generations"],["submissions","submissions"],["v1Archives","archives"]] as const){
        const store=tx.objectStore(name), indexed=store.indexNames.contains("scope");
        if(!indexed)result.warnings.push(`DRAFT_INDEX_REQUIRES_REVIEW:${name}`);
        const request=indexed?store.index("scope").getAll(scopeKey(scope)):store.getAll();
        request.onsuccess=()=>{result[key]=request.result.filter(r=>sameScope(r,scope));};
      }
      finish(result);
    });
    for(const g of snapshot.generations){try{assertGeneration(g,scope);}catch{snapshot.warnings.push(`DRAFT_REQUIRES_REVIEW:${g.generationId}`);}}
    if(snapshot.head?.generationId&&!snapshot.generations.some(g=>g.generationId===snapshot.head!.generationId))snapshot.warnings.push("DRAFT_HEAD_MISSING_GENERATION");
    for(const s of snapshot.submissions){if(sha256(s.requestBytes)!==s.requestSha256)snapshot.warnings.push(`DRAFT_SUBMISSION_REQUIRES_REVIEW:${s.requestId}`);}
    for(const a of snapshot.archives){if(sha256(a.original)!==a.v1Sha256)snapshot.warnings.push("V1_ARCHIVE_REQUIRES_REVIEW");}
    return snapshot;
  }
  private addGeneration(tx:IDBTransaction,g:DraftGeneration,done:()=>void,fail:(e:Error)=>void) {
    const store=tx.objectStore("generations"), request=store.get([...scopeKey(g),g.generationId]);
    request.onsuccess=()=>{
      if(request.result){if(canonicalJson(request.result)!==canonicalJson(g)){fail(new DraftError("DRAFT_GENERATION_COLLISION"));return;}}
      else store.add(g);
      done();
    };
  }
  async retain(scope:DraftScope,base:DraftBase,proposal:DraftGeneration,archive?:V1Archive):Promise<{status:"retained"|"conflict"|"archived";snapshot:DraftSnapshot;generationId:string|null}> {
    assertGeneration(proposal,scope);
    if(proposal.envelope.parentGenerationId!==base.generationId||proposal.envelope.parentRevision!==base.localRevision)throw new DraftError("DRAFT_PARENT_MISMATCH");
    if(archive&&(!sameScope(archive,scope)||sha256(archive.original)!==archive.v1Sha256))throw new DraftError("V1_ARCHIVE_REQUIRES_REVIEW");
    const result=await this.transaction<{status:"retained"|"conflict"|"archived";generationId:string|null}>(["heads","generations","submissions","v1Archives"],"readwrite",(tx,finish,fail)=>{
      const proceed=()=>{
        const heads=tx.objectStore("heads"), request=heads.get(scopeKey(scope));
        request.onsuccess=()=>{
          const current:DraftHead|null=request.result??null, matches=sameBase(current,base);
          const existing=tx.objectStore("generations").get([...scopeKey(scope),proposal.generationId]);
          existing.onsuccess=()=>{
          if(existing.result){
            const prior=existing.result as DraftGeneration;
            if(prior.sha256!==proposal.sha256||canonicalJson(prior.envelope)!==canonicalJson(proposal.envelope)||canonicalJson(prior.supersedes)!==canonicalJson(proposal.supersedes)||canonicalJson(prior.resolves)!==canonicalJson(proposal.resolves)){fail(new DraftError("DRAFT_GENERATION_COLLISION"));return;}
            finish({status:prior.disposition==="conflict-branch"?"conflict":"retained",generationId:prior.generationId});return;
          }
          if(matches&&proposal.envelope.pendingRequestId!==(current?.pendingRequestId??null)){fail(new DraftError("DRAFT_PENDING_CHANGED"));return;}
          const g={...proposal,disposition:matches?proposal.disposition:"conflict-branch" as const};
          this.addGeneration(tx,g,()=>{
            if(matches)heads.put({...scope,localRevision:(BigInt(base.localRevision)+BigInt(1)).toString(),generationId:g.generationId,
              state:g.disposition==="tombstone"?"closed":"outstanding",pendingRequestId:current?.pendingRequestId??null} satisfies DraftHead);
            if(archive)tx.objectStore("v1Archives").add({...archive,generationId:g.generationId});
            finish({status:matches?"retained":"conflict",generationId:g.generationId});
          },fail);
          };
        };
      };
      if(archive){
        const request=tx.objectStore("v1Archives").get([...scopeKey(scope),archive.v1Sha256]);
        request.onsuccess=()=>{
          if(request.result){
            if(request.result.original!==archive.original){fail(new DraftError("V1_ARCHIVE_COLLISION"));return;}
            finish({status:"archived",generationId:request.result.generationId});
          }else proceed();
        };
      }else proceed();
    });
    const snapshot=await this.read(scope);
    if(!snapshot.generations.some(g=>g.generationId===result.generationId&&g.sha256===proposal.sha256)&&result.status!=="archived")throw new DraftError("DRAFT_READBACK_FAILED");
    if(snapshot.warnings.length)throw new DraftError("DRAFT_REQUIRES_REVIEW");
    if(result.status==="retained"&&snapshot.head?.generationId!==result.generationId)result.status="conflict";
    return {...result,snapshot};
  }
  async prepare(scope:DraftScope,base:DraftBase,capabilitySha256:string):Promise<DraftSubmission> {
    const snapshot=await this.read(scope);
    if(snapshot.warnings.length)throw new DraftError("DRAFT_REQUIRES_REVIEW");
    const g=snapshot.generations.find(g=>g.generationId===base.generationId);
    if(!g)throw new DraftError("DRAFT_HEAD_CHANGED");
    const proposed=submissionFor(g,commandFor(g,capabilitySha256));
    const result=await this.transaction<DraftSubmission>(["heads","generations","submissions"],"readwrite",(tx,finish,fail)=>{
      const heads=tx.objectStore("heads"), request=heads.get(scopeKey(scope));
      request.onsuccess=()=>{
        const head:DraftHead|null=request.result??null;
        if(head?.pendingRequestId){
          const pending=tx.objectStore("submissions").get([scope.managerId,head.pendingRequestId]);
          pending.onsuccess=()=>pending.result&&pending.result.state==="prepared"?finish(pending.result):fail(new DraftError("DRAFT_PENDING_REQUIRES_REVIEW"));return;
        }
        if(!sameBase(head,base)||head?.state!=="outstanding"){fail(new DraftError("DRAFT_HEAD_CHANGED"));return;}
        const check=tx.objectStore("generations").get([...scopeKey(scope),g.generationId]);
        check.onsuccess=()=>{
          if(!check.result||canonicalJson(check.result)!==canonicalJson(g)){fail(new DraftError("DRAFT_REQUIRES_REVIEW"));return;}
          tx.objectStore("submissions").add(proposed);
          heads.put({...head,localRevision:(BigInt(head.localRevision)+BigInt(1)).toString(),pendingRequestId:proposed.requestId});
          finish(proposed);
        };
      };
    });
    const after=await this.read(scope), stored=after.submissions.find(s=>s.requestId===result.requestId);
    if(after.warnings.length||!stored||stored.requestBytes!==result.requestBytes||after.head?.pendingRequestId!==result.requestId)throw new DraftError("DRAFT_READBACK_FAILED");
    return result;
  }
  async applyReceipt(scope:DraftScope,submission:DraftSubmission,receipt:PaintReceipt):Promise<{saved:true;cleanupPending:boolean;snapshot:DraftSnapshot|null}> {
    assertReceipt(submission,receipt);
    for(let attempt=0;attempt<8;attempt++){
      try {
        const before=await this.read(scope), head=before.head;
        if(before.warnings.length)throw new DraftError("DRAFT_REQUIRES_REVIEW");
        const stored=before.submissions.find(s=>s.requestId===submission.requestId);
        if(!stored||stored.requestBytes!==submission.requestBytes)throw new DraftError("DRAFT_SUBMISSION_REQUIRES_REVIEW");
        if(stored.state==="confirmed")return {saved:true,cleanupPending:false,snapshot:before};
        const current=before.generations.find(g=>g.generationId===head?.generationId);
        if(!current||!head||head.pendingRequestId!==submission.requestId)throw new DraftError("DRAFT_PENDING_REQUIRES_REVIEW");
        const submitted=new Set(submission.submittedIntentIds), remaining=current.envelope.intents.filter(i=>!submitted.has(i.intentId));
        const first=[...remaining].sort((a,b)=>a.editedAt.localeCompare(b.editedAt)||a.intentId.localeCompare(b.intentId))[0];
        const e=newEnvelope({...current.envelope,parentGenerationId:current.generationId,parentRevision:head.localRevision,
          intents:remaining,pendingRequestId:null,
          episodeId:first?`residual:${contentHash([submission.requestId,first.intentId])}`:current.envelope.episodeId,
          firstDirtyAt:current.envelope.timeProvenance==="recovered-v1"?null:first?.editedAt??null,
          reviewReasons:remaining.length?[...new Set([...current.envelope.reviewReasons,"SAVED_COMMAND_CHANGED_EXPECTATIONS"])]:[]});
        const residual=generation(scope,e);
        const applied=await this.transaction<boolean>(["heads","generations","submissions"],"readwrite",(tx,finish,fail)=>{
          const heads=tx.objectStore("heads"), request=heads.get(scopeKey(scope));
          request.onsuccess=()=>{
            if(!sameBase(request.result??null,head)||request.result.pendingRequestId!==submission.requestId){finish(false);return;}
            this.addGeneration(tx,residual,()=>{
              tx.objectStore("submissions").put({...stored,state:"confirmed",response:receipt} satisfies DraftSubmission);
              heads.put({...head,localRevision:(BigInt(head.localRevision)+BigInt(1)).toString(),generationId:residual.generationId,
                pendingRequestId:null,state:remaining.length?"outstanding":"closed"} satisfies DraftHead);finish(true);
            },fail);
          };
        });
        if(applied)return {saved:true,cleanupPending:false,snapshot:await this.read(scope)};
      }catch {return {saved:true,cleanupPending:true,snapshot:null};}
    }
    return {saved:true,cleanupPending:true,snapshot:null};
  }
  async reject(scope:DraftScope,submission:DraftSubmission,code:string):Promise<void> {
    await this.transaction<void>(["heads","submissions"],"readwrite",(tx,finish,fail)=>{
      const store=tx.objectStore("submissions"), request=store.get([scope.managerId,submission.requestId]);
      request.onsuccess=()=>{
        const current:DraftSubmission|undefined=request.result;
        if(!current||current.requestBytes!==submission.requestBytes){fail(new DraftError("DRAFT_SUBMISSION_REQUIRES_REVIEW"));return;}
        if(current.state==="confirmed"){finish();return;}
        store.put({...current,state:"rejected",rejection:code});
        const heads=tx.objectStore("heads"), head=heads.get(scopeKey(scope));
        head.onsuccess=()=>{
          if(head.result?.pendingRequestId===submission.requestId)heads.put({...head.result,pendingRequestId:null,localRevision:(BigInt(head.result.localRevision)+BigInt(1)).toString()});finish();
        };
      };
    });
  }
  async discard(scope:DraftScope,base:DraftBase) {
    const snapshot=await this.read(scope), current=snapshot.generations.find(g=>g.generationId===base.generationId);
    if(snapshot.warnings.length||!current)throw new DraftError("DRAFT_REQUIRES_REVIEW");
    if(snapshot.head?.pendingRequestId)throw new DraftError("SAVE_STATUS_UNCONFIRMED");
    const e=newEnvelope({...current.envelope,parentGenerationId:base.generationId,parentRevision:base.localRevision,intents:[],reviewReasons:[],pendingRequestId:null});
    return this.retain(scope,base,generation(scope,e));
  }
  async dates(managerId:string,board:DraftScope["board"]):Promise<string[]> {
    return this.transaction(["heads","generations"],"readonly",(tx,finish)=>{
      const store=tx.objectStore("heads"), request=store.indexNames.contains("manager")?store.index("manager").getAll(managerId):store.getAll();
      const dates=new Set<string>();
      request.onsuccess=()=>{for(const h of request.result as DraftHead[])if(h.managerId===managerId&&h.board===board&&h.state==="outstanding")dates.add(h.date);};
      const branches=tx.objectStore("generations").getAll();
      branches.onsuccess=()=>{const all=branches.result as DraftGeneration[], resolved=new Set(all.flatMap(g=>g.resolves));for(const g of all)if(g.managerId===managerId&&g.board===board&&g.disposition==="conflict-branch"&&!resolved.has(g.generationId))dates.add(g.date);finish([...dates].sort());};
    });
  }
  /** Other V2 controls retain exact requests and outcomes in the preserved metadata store. */
  async retainCommand(key:string,command:{actionSha256:string;requestBytes:string;requestSha256:string}):Promise<typeof command>{
    const result=await this.transaction<typeof command>(["clientMeta"],"readwrite",(tx,finish,fail)=>{
      const store=tx.objectStore("clientMeta"),request=store.get(key);
      request.onsuccess=()=>{
        const prior=request.result?.value;
        if(prior?.state==="pending"){
          if(prior.actionSha256!==command.actionSha256){fail(new DraftError("ANOTHER_COMMAND_UNCONFIRMED"));return;}
          if(sha256(prior.requestBytes)!==prior.requestSha256){fail(new DraftError("COMMAND_REQUIRES_REVIEW"));return;}
          finish(prior);return;
        }
        store.put({key,value:{...command,state:"pending"}});finish(command);
      };
    });
    const check=await this.transaction<unknown>(["clientMeta"],"readonly",(tx,finish)=>{const r=tx.objectStore("clientMeta").get(key);r.onsuccess=()=>finish(r.result?.value?.requestBytes);});
    if(check!==result.requestBytes)throw new DraftError("COMMAND_READBACK_FAILED");return result;
  }
  async finishCommand(key:string,bytes:string,state:"confirmed"|"rejected",response:unknown){
    await this.transaction<void>(["clientMeta"],"readwrite",(tx,finish,fail)=>{
      const store=tx.objectStore("clientMeta"),r=store.get(key);r.onsuccess=()=>{
        if(r.result?.value?.requestBytes!==bytes){fail(new DraftError("COMMAND_CHANGED"));return;}
        store.put({key:`${key}:${sha256(bytes)}`,value:{...r.result.value,state,response}});
        store.put({key,value:{...r.result.value,state,response}});finish();
      };
    });
  }
  async clientInstance():Promise<string> {
    const proposed=randomId();
    return this.transaction(["clientMeta"],"readwrite",(tx,finish)=>{
      const store=tx.objectStore("clientMeta"), request=store.get("instance");
      request.onsuccess=()=>{if(request.result){finish((request.result as Meta).value as string);}else{store.add({key:"instance",value:proposed});finish(proposed);}};
    });
  }
  async probe():Promise<"commit-readback-ok"> {
    const key=`probe:${randomId()}`, value=randomId();
    await this.transaction<void>(["clientMeta"],"readwrite",(tx,finish)=>{tx.objectStore("clientMeta").add({key,value});finish();});
    const read=await this.transaction<unknown>(["clientMeta"],"readonly",(tx,finish)=>{const r=tx.objectStore("clientMeta").get(key);r.onsuccess=()=>finish(r.result?.value);});
    if(read!==value)throw new DraftError("DRAFT_READBACK_FAILED");
    await this.transaction<void>(["clientMeta"],"readwrite",(tx,finish)=>{tx.objectStore("clientMeta").delete(key);finish();});
    return "commit-readback-ok";
  }
}
export function activeGeneration(snapshot:DraftSnapshot):DraftGeneration|null {
  return snapshot.generations.find(g=>g.generationId===snapshot.head?.generationId)??null;
}
export function conflictBranches(snapshot:DraftSnapshot):DraftGeneration[] {
  const resolved=new Set(snapshot.generations.flatMap(g=>g.resolves));
  return snapshot.generations.filter(g=>g.disposition==="conflict-branch"&&!resolved.has(g.generationId));
}
export { emptyBase };
