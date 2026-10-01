import { z } from "zod";
import { readLastBoardFor } from "@/lib/offline-board";
import type { DayBoardDto } from "@/components/board/types";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { boardFromV2, publicDaySchema, readBoardV2, saveBoardV2, type PublicDayV2 } from "./day";
import { DraftDatabase } from "./draft-db";
import { assertReceipt, DraftError, type DraftScope, type DraftSubmission } from "./draft-types";
import type { PaintReceipt } from "../transaction";

export const capabilitySchema=z.object({protocol:z.literal(2),schema:z.literal(2),artifactRole:z.string(),activation:z.boolean(),recovery:z.boolean(),quarterUi:z.boolean(),
  blockNotes:z.boolean(),phase:z.enum(["legacy","prepared","active"]),databaseEpoch:z.string().nullable(),capabilitySha256:z.string().regex(/^[a-f0-9]{64}$/)});
export type Capabilities=z.infer<typeof capabilitySchema>;
export async function capabilities():Promise<Capabilities> {
  const response=await fetch("/api/paint/capabilities",{cache:"no-store"});
  if(!response.ok)throw new DraftError("PAINT_PROTOCOL_UNAVAILABLE");
  return capabilitySchema.parse(await response.json());
}
export function matchCapabilities(cap:Capabilities,day:Pick<PublicDayV2,"databaseEpoch"|"capabilitySha256"|"phase">) {
  if(cap.databaseEpoch!==day.databaseEpoch||cap.capabilitySha256!==day.capabilitySha256||cap.phase!==day.phase)throw new DraftError("PAINT_SNAPSHOT_CHANGED");
}
/** Prepared retains hourly behavior. Active uses only explicit V2 intervals and V2 writes. */
export async function fetchCompatibleBoard(board:"caja"|"cocina",date:string,token:string|null=null):Promise<{status:number;day:DayBoardDto|null}> {
  const cap=await capabilities(), headers=managerAuthHeaders(token);
  if(cap.phase==="legacy"){
    const response=await fetch(`/api/boards/${board}/days/${date}`,{headers,cache:"no-store"});
    return {status:response.status,day:response.ok?await response.json():null};
  }
  const response=await fetch(`/api/v2/boards/${board}/days/${date}`,{headers,cache:"no-store"});
  if(!response.ok)return {status:response.status,day:null};
  const publicDay=publicDaySchema.parse(await response.json());matchCapabilities(cap,publicDay);
  let day=boardFromV2(publicDay);
  if(cap.phase==="prepared"){
    const legacy=await fetch(`/api/boards/${board}/days/${date}`,{headers,cache:"no-store"});
    if(!legacy.ok)return {status:legacy.status,day:null};
    day=await legacy.json();day.bridge=publicDay;
  }else if(token){
    const privateResponse=await fetch(`/api/v2/boards/${board}/days/${date}/management`,{headers,cache:"no-store"});
    if(privateResponse.ok){
      const extra=await privateResponse.json();
      // Manager/owner fields are never placed in the public DTO or cache.
      if(extra.databaseEpoch===publicDay.databaseEpoch&&extra.worldRevision===publicDay.worldRevision){
        day.quarterManagerId=extra.managerId;day.mandatory=extra.mandatory;day.overlayMenu=extra.overlayMenu;
        for(const shift of day.shifts)if(extra.abilities?.[shift.employee.id])shift.employee.abilities=extra.abilities[shift.employee.id];
      }
    }
  }
  saveBoardV2(publicDay);
  return {status:200,day};
}
export function compatibleCachedBoard(board:"caja"|"cocina",now=new Date()) {
  const cached=readBoardV2(board,now);
  if(cached.status==="available")return {board,date:cached.day.date,day:cached.day,savedAt:cached.savedAt,version:2 as const};
  return cached.status==="missing"?readLastBoardFor(board,now):null;
}
export type SaveOutcome={status:"saved"|"cleanup-pending"|"unconfirmed"|"rejected";code?:string;receipt?:PaintReceipt};
/** Exact retained bytes only. A missing response never grants permission to create another ID. */
export async function sendSubmission(db:DraftDatabase,scope:DraftScope,submission:DraftSubmission,token:string,replay=false):Promise<SaveOutcome>{
  const snapshot=await db.read(scope), retained=snapshot.submissions.find(s=>s.requestId===submission.requestId);
  if(snapshot.warnings.length||!retained||retained.requestBytes!==submission.requestBytes)throw new DraftError("DRAFT_NOT_RETAINED");
  let response:Response;
  try{
    response=await fetch(replay?`/api/v2/assignments/paint/receipts/${encodeURIComponent(submission.requestId)}`:"/api/v2/assignments/paint",replay?
      {headers:managerAuthHeaders(token),cache:"no-store"}:{method:"PUT",headers:{...managerAuthHeaders(token),"Content-Type":"application/vnd.floor-boards.paint-v2+json","X-Floor-Boards-Protocol":"2"},body:submission.requestBytes});
  }catch{return {status:"unconfirmed"};}
  let body:Record<string,unknown>;
  try{body=await response.json();}catch{return {status:"unconfirmed"};}
  if(response.ok){
    const receipt=body as PaintReceipt;assertReceipt(submission,receipt);
    const result=await db.applyReceipt(scope,submission,receipt);
    return {status:result.cleanupPending?"cleanup-pending":"saved",receipt};
  }
  if(!replay&&[400,409,413,415,422,426].includes(response.status)){
    const code=typeof body.code==="string"?body.code:"SAVE_REJECTED";
    await db.reject(scope,submission,code);return {status:"rejected",code};
  }
  return {status:"unconfirmed",code:typeof body.code==="string"?body.code:undefined};
}
