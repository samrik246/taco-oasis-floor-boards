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

/** Repeat other V2 actions with retained bytes until an exact receipt or definite rejection. */
export async function savedAction(scope:DraftScope,day:Pick<PublicDayV2,"databaseEpoch"|"worldRevision"|"phase"|"capabilitySha256">,kind:"tareas"|"shift-removals",action:Record<string,unknown>,token:string|null){
  const { canonicalJson,sha256,randomId }=await import("./primitives");
  const { managerAuthHeaders }=await import("@/lib/managers/auth-headers");
  const cap=await capabilities();matchCapabilities(cap,day);
  if(!day.databaseEpoch||day.worldRevision===null||cap.phase!=="active")throw new DraftError("QUARTER_NOT_ACTIVE");
  const db=await DraftDatabase.open(),key=`command:${scope.managerId}:${scope.board}:${scope.date}:${kind}`;
  try{
    const bytes=canonicalJson({protocol:2,requestId:randomId(),capabilitySha256:cap.capabilitySha256,date:scope.date,
      expected:{databaseEpoch:day.databaseEpoch,worldRevision:day.worldRevision},...action});
    const retained=await db.retainCommand(key,{actionSha256:sha256(canonicalJson(action)),requestBytes:bytes,requestSha256:sha256(bytes)});
    const original=JSON.parse(retained.requestBytes);
    let response:Response,body:Record<string,unknown>;
    try{response=await fetch(`/api/v2/${kind}`,{method:"POST",headers:{...managerAuthHeaders(token),"Content-Type":"application/vnd.floor-boards.paint-v2+json","X-Floor-Boards-Protocol":"2"},body:retained.requestBytes});body=await response.json();}
    catch{return {status:"unconfirmed" as const};}
    if(response.ok){
      if(body.requestId!==original.requestId||body.requestSha256!==retained.requestSha256||body.databaseEpoch!==original.expected.databaseEpoch)throw new DraftError("RECEIPT_BINDING_MISMATCH");
      try{await db.finishCommand(key,retained.requestBytes,"confirmed",body);return {status:"saved" as const,body};}
      catch{return {status:"cleanup-pending" as const,body};}
    }
    if([400,409,413,415,422,426].includes(response.status)){await db.finishCommand(key,retained.requestBytes,"rejected",body);return {status:"rejected" as const,body};}
    return {status:"unconfirmed" as const};
  }finally{db.close();}
}
