import {DraftDatabase} from "./draft-db";
import {LEGACY_BOARD_CACHE} from "./day";
import {managerAuthHeaders} from "@/lib/managers/auth-headers";
import {DraftError} from "./draft-types";
// Next substitutes this expression in the loaded bundle; it is not copied from a server reply.
export const CLIENT_BUILD_SHA=process.env.NEXT_PUBLIC_QUARTER_SOURCE_SHA??"unbuilt";
export async function clientIdentity(){const db=await DraftDatabase.open();try{return await db.clientInstance();}finally{db.close();}}
export async function measureClient(challenge:{challengeId:string;databaseEpoch:string;schemaFingerprint:string},role:"floor"|"wall"|"editor",board:"caja"|"cocina"){
  const db=await DraftDatabase.open();try{
    const clientInstanceId=await db.clientInstance(),idbProbe=await db.probe();
    // Only the obsolete PUBLIC board cache is retired. Private V1 drafts remain untouched.
    localStorage.removeItem(LEGACY_BOARD_CACHE);
    if(localStorage.getItem(LEGACY_BOARD_CACHE)!==null)throw new DraftError("LEGACY_BOARD_CACHE_REMAINS");
    const response=await fetch("/api/paint/capabilities",{cache:"no-store"}),cap=await response.json();
    if(!response.ok||cap.databaseEpoch!==challenge.databaseEpoch||cap.schemaFingerprint!==challenge.schemaFingerprint)throw new DraftError("PAINT_SNAPSHOT_CHANGED");
    return {challengeId:challenge.challengeId,clientInstanceId,origin:location.origin,role,board,clientBuildSha:CLIENT_BUILD_SHA,protocol:2,cacheSchema:2,draftDbVersion:1,isSecureContext, idbProbe,legacyBoardCacheAbsent:true,observedDatabaseEpoch:cap.databaseEpoch,schemaFingerprint:cap.schemaFingerprint};
  }finally{db.close();}
}
export async function postClientReadback(token:string,body:unknown){const response=await fetch("/api/v2/maintenance/clients",{method:"POST",headers:{...managerAuthHeaders(token),"Content-Type":"application/json"},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new DraftError(result.code??"CLIENT_READBACK_FAILED");return result;}
