/** Synthetic ordinary HTTP writer used while the candidate waits for a checker. No token is logged. */
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import {z} from "zod";
const [origin,date,shiftId,output,mode="write"]=process.argv.slice(2);
const url=new URL(origin);if(url.hostname!=="127.0.0.1"||url.protocol!=="http:"||!process.env.FLOOR_BOARDS_TEST_ROOT)throw new Error("SYNTHETIC_LOOPBACK_REQUIRED");
z.iso.date().parse(date);
async function main(){
  const login=await fetch(`${origin}/api/managers`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"quarter-rehearsal-owner"})});
  if(!login.ok)throw new Error("SYNTHETIC_LOGIN_FAILED");
  const {sessionToken}=await login.json();const headers={"x-manager-session":sessionToken,"Content-Type":"application/vnd.floor-boards.paint-v2+json","X-Floor-Boards-Protocol":"2"};
  const getDay=async()=>{const response=await fetch(`${origin}/api/v2/boards/caja/days/${date}`,{headers});if(!response.ok)throw new Error("SYNTHETIC_READ_FAILED");return response.json();};
  if(mode==="read"){writeFileSync(output,JSON.stringify(await getDay())+"\n");return;}
  const receipts:unknown[]=[],requests:unknown[]=[];
  for(const intents of [[{shiftId,quarter:"09:15",granularity:"quarter",action:"station",stationId:"green1"},{shiftId,quarter:"09:30",granularity:"quarter",action:"erase"},{shiftId,quarter:"12:00",granularity:"quarter",action:"station",stationId:"purple1"}],
    [{shiftId,quarter:"09:15",granularity:"quarter",action:"station",stationId:"blue"}]] as const){
    const day=await getDay();const command={protocol:2,requestId:randomUUID(),capabilitySha256:day.capabilitySha256,board:"caja",date,expected:{databaseEpoch:day.databaseEpoch,worldRevision:day.worldRevision},
      sources:day.sources.filter((s:{shiftId:string})=>s.shiftId===shiftId),hours:day.hours.filter((h:{shiftId:string})=>h.shiftId===shiftId).map((h:{shiftId:string;hourStart:string;revision:string|null;legacySha256?:string})=>({shiftId:h.shiftId,hourStart:h.hourStart,revision:h.revision,...(h.revision===null?{legacySha256:h.legacySha256}:{})})),intents};
    const response=await fetch(`${origin}/api/v2/assignments/paint`,{method:"PUT",headers,body:JSON.stringify(command)}),receipt=await response.json();
    if(!response.ok)throw new Error(`SYNTHETIC_SAVE_FAILED:${receipt.code}`);requests.push(command);receipts.push(receipt);
  }
  writeFileSync(output,JSON.stringify({requests,receipts,day:await getDay()})+"\n");
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
