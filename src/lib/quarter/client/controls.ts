import { DraftDatabase,conflictBranches } from "./draft-db";
import { DraftError,type DraftScope } from "./draft-types";
import { capabilities,matchCapabilities,sendSubmission } from "./transport";
import { proposeHours,type HourChange } from "./edit";
import { observeV1 } from "./v1-conversion";
import type { PublicDayV2 } from "./day";

/** Direct controls still retain the original bytes before HTTP. They never submit unrelated private edits. */
export async function saveHourControl(scope:DraftScope,day:PublicDayV2,changes:HourChange[],token:string){
  const cap=await capabilities();matchCapabilities(cap,day);
  const db=await DraftDatabase.open();
  try{
    const {snapshot}=await observeV1(db,scope,day);
    if(snapshot.head?.state==="outstanding"||snapshot.head?.pendingRequestId||conflictBranches(snapshot).length||snapshot.warnings.length)
      throw new DraftError("OPEN_DRAFT_IN_COLOR_EDITOR");
    const {base,proposal}=proposeHours(scope,snapshot,day,changes);
    const retained=await db.retain(scope,base,proposal);
    if(retained.status!=="retained"||conflictBranches(retained.snapshot).length)throw new DraftError("DRAFT_REQUIRES_REVIEW");
    const submission=await db.prepare(scope,retained.snapshot.head!,cap.capabilitySha256);
    return await sendSubmission(db,scope,submission,token);
  }finally{db.close();}
}

export type ActionKind="tareas"|"shift-removals"|"assignments/operations";
const kinds:ActionKind[]=["tareas","shift-removals","assignments/operations"];
export const commandKey=(scope:DraftScope,kind:ActionKind)=>`command:${scope.managerId}:${scope.board}:${scope.date}:${kind}`;

/** Reconcile an original request explicitly; current revisions never replace its expectations. */
export async function resumeAction(scope:DraftScope,key:string,token:string|null){
  const { managerAuthHeaders }=await import("@/lib/managers/auth-headers");
  const kind=kinds.find(k=>key===commandKey(scope,k));if(!kind)throw new DraftError("COMMAND_SCOPE_MISMATCH");
  if(!token&&(scope.managerId!=="system:staff-status"||kind!=="tareas"))throw new DraftError("MANAGER_REQUIRED");
  const db=await DraftDatabase.open();
  try{
    db.assertWritable();
    if((await db.read(scope)).warnings.length)throw new DraftError("DRAFT_REQUIRES_REVIEW");
    const retained=(await db.pendingCommands(scope)).find(r=>r.key===key)?.value;
    if(!retained)throw new DraftError("COMMAND_NOT_PENDING");
    const original=JSON.parse(retained.requestBytes),cap=await capabilities();
    if(original.date!==scope.date||original.expected?.databaseEpoch!==cap.databaseEpoch)throw new DraftError("DATABASE_EPOCH_CHANGED");
    // A known receipt remains replayable after later world/capability revisions.
    let response:Response,body:Record<string,unknown>;
    try{response=await fetch(`/api/v2/${kind}`,{method:"POST",headers:{...managerAuthHeaders(token),"Content-Type":"application/vnd.floor-boards.paint-v2+json","X-Floor-Boards-Protocol":"2"},body:retained.requestBytes});body=await response.json();}
    catch{return {status:"unconfirmed" as const};}
    if(response.ok){
      if(body.ok!==true||body.requestId!==original.requestId||body.requestSha256!==retained.requestSha256||body.databaseEpoch!==original.expected.databaseEpoch||!Array.isArray(body.dates)||!body.dates.includes(scope.date))throw new DraftError("RECEIPT_BINDING_MISMATCH");
      try{await db.finishCommand(key,retained.requestBytes,"confirmed",body);window.dispatchEvent(new Event("quarter-commands-changed"));return {status:"saved" as const,body};}
      catch{return {status:"cleanup-pending" as const,body};}
    }
    if([400,409,413,415,422,426].includes(response.status)){await db.finishCommand(key,retained.requestBytes,"rejected",body);window.dispatchEvent(new Event("quarter-commands-changed"));return {status:"rejected" as const,body};}
    return {status:"unconfirmed" as const};
  }finally{db.close();}
}

/** Repeat other V2 actions with retained bytes until an exact receipt or definite rejection. */
export async function savedAction(scope:DraftScope,day:Pick<PublicDayV2,"databaseEpoch"|"worldRevision"|"phase"|"capabilitySha256">,kind:ActionKind,action:Record<string,unknown>,token:string|null){
  const { canonicalJson,sha256,randomId }=await import("./primitives");
  const cap=await capabilities();matchCapabilities(cap,day);
  if(!day.databaseEpoch||day.worldRevision===null||cap.phase!=="active")throw new DraftError("QUARTER_NOT_ACTIVE");
  const db=await DraftDatabase.open(),key=commandKey(scope,kind);
  try{
    const bytes=canonicalJson({protocol:2,requestId:randomId(),capabilitySha256:cap.capabilitySha256,date:scope.date,
      expected:{databaseEpoch:day.databaseEpoch,worldRevision:day.worldRevision},...action});
    if(new TextEncoder().encode(bytes).length>2*1024*1024)throw new DraftError("REQUEST_TOO_LARGE");
    await db.retainCommand(key,{actionSha256:sha256(canonicalJson(action)),requestBytes:bytes,requestSha256:sha256(bytes)});
  }finally{db.close();}
  return resumeAction(scope,key,token);
}
