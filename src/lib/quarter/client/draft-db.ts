import type { PaintReceipt } from "../transaction";
import { operationSchema, removalCommandSchema, tareaCommandSchema } from "../action-shapes";
import { canonicalJson, contentHash, randomId, sha256 } from "./primitives";
import {
  assertGeneration, assertHead, assertSubmission, assertReceipt, commandFor, DraftError, emptyBase, generation, newEnvelope,
  sameBase, sameScope, scopeKey, submissionFor,
  type DraftBase, type DraftGeneration, type DraftHead, type DraftScope, type DraftSnapshot,
  type DraftSubmission, type V1Archive,
} from "./draft-types";

export const DRAFT_DATABASE = "taco-oasis-paint-drafts";
export const DRAFT_DATABASE_VERSION = 1;
export const DRAFT_STORES = ["heads","generations","submissions","v1Archives","clientMeta"] as const;
type Store = typeof DRAFT_STORES[number];
type RetainedCommand={actionSha256:string;requestBytes:string;requestSha256:string;state:"pending"|"confirmed"|"rejected";response?:unknown};
function assertCommand(value:unknown,key:string):asserts value is RetainedCommand {
  const v=value as RetainedCommand|null;
  if(!v||!["pending","confirmed","rejected"].includes(v.state)||typeof v.requestBytes!=="string"||sha256(v.requestBytes)!==v.requestSha256||typeof v.actionSha256!=="string"||!/^[a-f0-9]{64}$/.test(v.actionSha256))throw new DraftError("COMMAND_REQUIRES_REVIEW");
  try{
    const expectedKeys=["actionSha256","requestBytes","requestSha256","state",...(v.state==="pending"?[]:["response"])].sort();
    if(canonicalJson(Object.keys(v).sort())!==canonicalJson(expectedKeys)||new TextEncoder().encode(v.requestBytes).length>2*1024*1024)throw new Error();
    const scope=/^command:(.+):(caja|cocina):(\d{4}-\d{2}-\d{2}):(tareas|shift-removals|assignments\/operations)$/.exec(key);
    if(!scope)throw new Error();
    const schema=scope[4]==="tareas"?tareaCommandSchema:scope[4]==="shift-removals"?removalCommandSchema:operationSchema;
    const body=schema.parse(JSON.parse(v.requestBytes));
    if(body.date!==scope[3]||("board" in body&&body.board!==scope[2])||canonicalJson(body)!==v.requestBytes)throw new Error();
  }catch{throw new DraftError("COMMAND_REQUIRES_REVIEW");}
}
type Meta = { key:string; value:unknown };
function commandValue(row:unknown,key:string,scopeKey=key):RetainedCommand {
  const r=row as Meta|null;
  if(!r||r.key!==key||canonicalJson(Object.keys(r).sort())!==canonicalJson(["key","value"]))throw new DraftError("COMMAND_REQUIRES_REVIEW");
  assertCommand(r.value,scopeKey);return r.value;
}

/** An unexpected schema must be read by its own version, never normalized by writes. */
function checkDatabaseSchema(db:IDBDatabase) {
  if(canonicalJson([...db.objectStoreNames].sort())!==canonicalJson([...DRAFT_STORES].sort()))throw new Error("stores");
  const tx=db.transaction([...DRAFT_STORES],"readonly"),warnings:string[]=[];
  for(const name of DRAFT_STORES){
    const store=tx.objectStore(name);
    const key=name==="clientMeta"?"key":name==="submissions"?["managerId","requestId"]:["managerId","board","date",...(name==="heads"?[]:[name==="generations"?"generationId":"v1Sha256"])];
    const indices=name==="clientMeta"?[]:[name==="heads"?"manager":"scope"];
    if(store.autoIncrement||canonicalJson(store.keyPath)!==canonicalJson(key))throw new Error("store schema");
    let mismatch=canonicalJson([...store.indexNames])!==canonicalJson(indices);
    for(const indexName of indices){
      if(!store.indexNames.contains(indexName)){mismatch=true;continue;}
      const index=store.index(indexName),key=indexName==="manager"?"managerId":["managerId","board","date"];
      if(index.unique||index.multiEntry||canonicalJson(index.keyPath)!==canonicalJson(key))mismatch=true;
    }
    if(mismatch)warnings.push(`DRAFT_INDEX_REQUIRES_REVIEW:${name}`);
  }
  return warnings;
}
function scan<T>(store:IDBObjectStore,visit:(value:T)=>void) {
  const request=store.openCursor();
  request.onsuccess=()=>{const cursor=request.result;if(cursor){visit(cursor.value);cursor.continue();}};
}

/** IDB callbacks are synchronous. Completion, never request success, is the commit boundary. */
export class DraftDatabase {
  private changing = false;
  durability: "strict" | "default" = "default";
  private constructor(private db: IDBDatabase, private onState: (state:string)=>void, readonly schemaWarnings:readonly string[]) {
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
        let warnings:string[];
        try{warnings=checkDatabaseSchema(request.result);}catch{request.result.close();fail("DRAFT_SCHEMA_REQUIRES_REVIEW");return;}
        settled=true;resolve(new DraftDatabase(request.result,onState,Object.freeze(warnings)));
      };
    });
  }
  close() { this.changing=true; this.db.close(); }
  get readOnly() { return this.schemaWarnings.length>0; }
  assertWritable() {
    if(this.changing)throw new DraftError("DRAFT_CONNECTION_CLOSED");
    if(this.readOnly)throw new DraftError("DRAFT_READ_ONLY_REVIEW");
  }
  private transaction<T>(names: readonly Store[], mode: IDBTransactionMode,
    run:(tx:IDBTransaction, finish:(value:T)=>void, fail:(error:Error)=>void)=>void):Promise<T> {
    if(this.changing)return Promise.reject(new DraftError("DRAFT_CONNECTION_CLOSED"));
    if(mode==="readwrite"){try{this.assertWritable();}catch(error){return Promise.reject(error);}}
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
      const result:DraftSnapshot={head:null,generations:[],submissions:[],archives:[],warnings:[...this.schemaWarnings]};
      const head=tx.objectStore("heads").get(scopeKey(scope));head.onsuccess=()=>{result.head=head.result??null;};
      for(const [name,key] of [["generations","generations"],["submissions","submissions"],["v1Archives","archives"]] as const){
        const store=tx.objectStore(name);
        if(this.readOnly)scan<DraftGeneration & DraftSubmission & V1Archive>(store,row=>{if(row&&sameScope(row,scope))result[key].push(row);});
        else {const request=store.index("scope").getAll(scopeKey(scope));request.onsuccess=()=>{result[key]=request.result.filter(r=>r&&sameScope(r,scope));};}
      }
      finish(result);
    });
    if(snapshot.head){try{assertHead(snapshot.head,scope);}catch{snapshot.warnings.push("DRAFT_HEAD_REQUIRES_REVIEW");snapshot.head=null;}}
    snapshot.generations=snapshot.generations.filter(g=>{try{assertGeneration(g,scope);return true;}catch{snapshot.warnings.push(`DRAFT_REQUIRES_REVIEW:${g?.generationId??"unknown"}`);return false;}});
    if(snapshot.head?.generationId&&!snapshot.generations.some(g=>g.generationId===snapshot.head!.generationId))snapshot.warnings.push("DRAFT_HEAD_MISSING_GENERATION");
    snapshot.submissions=snapshot.submissions.filter(s=>{try{assertSubmission(s,scope);return true;}catch{snapshot.warnings.push(`DRAFT_SUBMISSION_REQUIRES_REVIEW:${s?.requestId??"unknown"}`);return false;}});
    for(const a of snapshot.archives){if(sha256(a.original)!==a.v1Sha256)snapshot.warnings.push("V1_ARCHIVE_REQUIRES_REVIEW");}
    if(!snapshot.head&&(snapshot.generations.length||snapshot.submissions.length||snapshot.archives.length))snapshot.warnings.push("DRAFT_HEAD_MISSING_REQUIRES_REVIEW");
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
    if((await this.read(scope)).warnings.length)throw new DraftError("DRAFT_REQUIRES_REVIEW");
    if(proposal.envelope.parentGenerationId!==base.generationId||proposal.envelope.parentRevision!==base.localRevision)throw new DraftError("DRAFT_PARENT_MISMATCH");
    if(archive&&(!sameScope(archive,scope)||sha256(archive.original)!==archive.v1Sha256))throw new DraftError("V1_ARCHIVE_REQUIRES_REVIEW");
    const result=await this.transaction<{status:"retained"|"conflict"|"archived";generationId:string|null}>(["heads","generations","submissions","v1Archives"],"readwrite",(tx,finish,fail)=>{
      const proceed=()=>{
        const heads=tx.objectStore("heads"), request=heads.get(scopeKey(scope));
        request.onsuccess=()=>{
          const current:DraftHead|null=request.result??null;
          try{if(current)assertHead(current,scope);}catch(e){fail(e as Error);return;}
          const matches=sameBase(current,base);
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
        try{if(head)assertHead(head,scope);}catch(e){fail(e as Error);return;}
        if(head?.pendingRequestId){
          const pending=tx.objectStore("submissions").get([scope.managerId,head.pendingRequestId]);
          pending.onsuccess=()=>{try{assertSubmission(pending.result,scope);if(pending.result.state!=="prepared")throw new DraftError("DRAFT_PENDING_REQUIRES_REVIEW");finish(pending.result);}catch(e){fail(e as Error);}};return;
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
    this.assertWritable();
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
    type Rows={heads:DraftHead[];generations:DraftGeneration[];submissions:DraftSubmission[];v1Archives:V1Archive[]};
    const {scopes,commands}=await this.transaction<{scopes:Map<string,Rows>;commands:Set<string>}>(["heads","generations","submissions","v1Archives","clientMeta"],"readonly",(tx,finish)=>{
      const scopes=new Map<string,Rows>(),commands=new Set<string>();
      finish({scopes,commands});
      for(const name of ["heads","generations","submissions","v1Archives"] as const)scan<DraftScope>(tx.objectStore(name),row=>{
        if(!row||row.managerId!==managerId||row.board!==board||typeof row.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(row.date))return;
        if(!scopes.has(row.date))scopes.set(row.date,{heads:[],generations:[],submissions:[],v1Archives:[]});
        (scopes.get(row.date)![name] as DraftScope[]).push(row);
      });
      const prefix=`command:${managerId}:${board}:`;
      scan<{key:string;value?:{state?:string}}>(tx.objectStore("clientMeta"),row=>{
        if(typeof row?.key==="string"&&row.key.startsWith(prefix)&&row.value?.state!=="confirmed"&&row.value?.state!=="rejected"){
          const date=row.key.slice(prefix.length).split(":")[0];if(/^\d{4}-\d{2}-\d{2}$/.test(date))commands.add(date);
        }
      });
    });
    for(const [date,rows] of scopes){
      const scope={managerId,board,date},head=rows.heads[0];
      try{assertHead(head,scope);}catch{commands.add(date);continue;}
      const valid=rows.generations.filter(g=>{try{assertGeneration(g,scope);return true;}catch{return false;}});
      const resolved=new Set(valid.flatMap(g=>g.resolves));
      if(head.state!=="closed"||head.pendingRequestId||(head.generationId&&!valid.some(g=>g.generationId===head.generationId))||valid.some(g=>g.disposition==="conflict-branch"&&!resolved.has(g.generationId)))commands.add(date);
      // A valid closed head owns its historical generations/archives; do not resurrect them.
    }
    return [...commands].sort();
  }
  /** Other V2 controls retain exact requests and outcomes in the preserved metadata store. */
  async retainCommand(key:string,command:{actionSha256:string;requestBytes:string;requestSha256:string}):Promise<typeof command>{
    const result=await this.transaction<typeof command>(["clientMeta"],"readwrite",(tx,finish,fail)=>{
      const store=tx.objectStore("clientMeta"),request=store.get(key);
      request.onsuccess=()=>{
        let prior:RetainedCommand|undefined;
        try{assertCommand({...command,state:"pending"},key);if(request.result)prior=commandValue(request.result,key);}catch(e){fail(e as Error);return;}
        if(prior?.state==="pending"){
          if(prior.actionSha256!==command.actionSha256){fail(new DraftError("ANOTHER_COMMAND_UNCONFIRMED"));return;}
          if(sha256(prior.requestBytes)!==prior.requestSha256){fail(new DraftError("COMMAND_REQUIRES_REVIEW"));return;}
          finish(prior);return;
        }
        store.put({key,value:{...command,state:"pending"}});finish(command);
      };
    });
    const check=await this.transaction<unknown>(["clientMeta"],"readonly",(tx,finish)=>{const r=tx.objectStore("clientMeta").get(key);r.onsuccess=()=>finish(r.result?.value?.requestBytes);});
    if(check!==result.requestBytes)throw new DraftError("COMMAND_READBACK_FAILED");
    window.dispatchEvent(new Event("quarter-commands-changed"));return result;
  }
  async pendingCommands(scope:DraftScope):Promise<{key:string;value:{actionSha256:string;requestBytes:string;requestSha256:string;state:"pending"}}[]> {
    const prefix=`command:${scope.managerId}:${scope.board}:${scope.date}:`;
    return this.transaction(["clientMeta"],"readonly",(tx,finish,fail)=>{
      const r=tx.objectStore("clientMeta").getAll();r.onsuccess=()=>{
        const scoped=r.result.filter(row=>typeof row.key==="string"&&row.key.startsWith(prefix)&&!row.key.slice(prefix.length).includes(":"));
        try{for(const row of scoped)commandValue(row,row.key);}catch(e){fail(e as Error);return;}
        const rows=scoped.filter(row=>row.value.state==="pending");
        if(rows.some(row=>typeof row.value.requestBytes!=="string"||sha256(row.value.requestBytes)!==row.value.requestSha256)){fail(new DraftError("COMMAND_REQUIRES_REVIEW"));return;}
        finish(rows);
      };
    });
  }
  async finishCommand(key:string,bytes:string,state:"confirmed"|"rejected",response:unknown){
    await this.transaction<void>(["clientMeta"],"readwrite",(tx,finish,fail)=>{
      const store=tx.objectStore("clientMeta"),r=store.get(key);r.onsuccess=()=>{
        try{commandValue(r.result,key);}catch(e){fail(e as Error);return;}
        if(r.result?.value?.requestBytes!==bytes){fail(new DraftError("COMMAND_CHANGED"));return;}
        if(r.result.value.state!=="pending"){
          if(r.result.value.state!==state||canonicalJson(r.result.value.response)!==canonicalJson(response)){fail(new DraftError("COMMAND_OUTCOME_CHANGED"));return;}
          finish();return;
        }
        const archiveKey=`${key}:${sha256(bytes)}`,value={...r.result.value,state,response};
        const archive=store.get(archiveKey);
        archive.onsuccess=()=>{
          try{
            if(archive.result){
              const prior=commandValue(archive.result,archiveKey,key);
              if(canonicalJson(prior)!==canonicalJson(value))throw new DraftError("COMMAND_OUTCOME_CHANGED");
            }else store.add({key:archiveKey,value});
            store.put({key,value});finish();
          }catch(e){fail(e as Error);}
        };
      };
    });
    const result=await this.transaction<RetainedCommand>(["clientMeta"],"readonly",(tx,finish,fail)=>{const archiveKey=`${key}:${sha256(bytes)}`,r=tx.objectStore("clientMeta").get(archiveKey);r.onsuccess=()=>{try{finish(commandValue(r.result,archiveKey,key));}catch(e){fail(e as Error);}};});
    if(!result||result.requestBytes!==bytes||result.state!==state||canonicalJson(result.response)!==canonicalJson(response))throw new DraftError("COMMAND_READBACK_FAILED");
  }
  async clientInstance():Promise<string> {
    const proposed=randomId();
    return this.transaction(["clientMeta"],"readwrite",(tx,finish,fail)=>{
      const store=tx.objectStore("clientMeta"), request=store.get("instance");
      request.onsuccess=()=>{if(request.result){const value=(request.result as Meta).value;if(typeof value!=="string"||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)){fail(new DraftError("CLIENT_ID_REQUIRES_REVIEW"));return;}finish(value);}else{store.add({key:"instance",value:proposed});finish(proposed);}};
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
