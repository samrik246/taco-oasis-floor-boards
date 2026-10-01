import { savedAction,resumeAction,commandKey } from "@/lib/quarter/client/controls";
import { DraftDatabase } from "@/lib/quarter/client/draft-db";
import { publicDaySchema } from "@/lib/quarter/client/day";
const date="2040-10-10";
async function session(){
 const response=await fetch("/api/managers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"e2e-second-owner"})});
 if(!response.ok)throw new Error("synthetic login failed");
 const login=await response.json();return {scope:{managerId:login.manager.id as string,board:"caja" as const,date},token:login.sessionToken as string};
}
const api={
 async save(){
  const {scope,token}=await session(),response=await fetch(`/api/v2/boards/caja/days/${date}`);
  const day=publicDaySchema.parse(await response.json()),source=day.sources.find(s=>s.shiftId==="r0-http-source")!;
  const hours=day.hours.filter(h=>h.shiftId===source.shiftId).map(h=>h.revision===null?{shiftId:h.shiftId,hourStart:h.hourStart,revision:null,legacySha256:h.legacySha256}:{shiftId:h.shiftId,hourStart:h.hourStart,revision:h.revision});
  return savedAction(scope,day,"assignments/operations",{operation:"whole-shift",board:"caja",sources:[source],hours,shiftId:source.shiftId,stationId:"green1"},token);
 },
 async recover(){const {scope,token}=await session();return resumeAction(scope,commandKey(scope,"assignments/operations"),token);},
 async pending(){const {scope}=await session(),db=await DraftDatabase.open();try{return await db.pendingCommands(scope);}finally{db.close();}},
};
declare global {interface Window{quarterActionProof:typeof api;}}
window.quarterActionProof=api;
