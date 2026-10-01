/** Host-only V2 read/preflight/apply. Exact original packet + loaded artifact pin, no hourly reconstruction. */
import {z} from "zod";
import {prisma} from "../src/lib/db";
import {paintCommandSchema} from "../src/lib/quarter/protocol";
import {previewPaintV2,paintV2} from "../src/lib/quarter/transaction";
import {readQuarterDay} from "../src/lib/quarter/public";
import {withReleaseLease} from "../src/lib/quarter/lease";
import {verifiedArtifact,loadedArtifactSha256,assertLoadedArtifactIdentity} from "../src/lib/quarter/artifact";
import {assertArtifactCompatibility} from "../src/lib/quarter/compatibility";
import {canonical,digest} from "../src/lib/quarter/schema";
const packet=z.strictObject({version:z.literal(2),artifactSha256:z.string().regex(/^[a-f0-9]{64}$/),agent:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{0,79}$/),command:paintCommandSchema});
async function main(){
  const [action,arg,date]=process.argv.slice(2);verifiedArtifact();await assertArtifactCompatibility(prisma);
  if(action==="--read"){
    const board=z.enum(["caja","cocina"]).parse(arg),day=z.iso.date().parse(date);
    console.log(canonical(await prisma.$transaction(db=>readQuarterDay(db,board,day))));return;
  }
  if(action!=="--preflight"&&action!=="--apply")throw new Error("Usage: quarter-agent.ts --read <board> <date> | --preflight | --apply <packet-sha256>");
  const chunks:Buffer[]=[];let size=0;for await(const chunk of process.stdin){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>2*1024*1024)throw new Error("REQUEST_TOO_LARGE");chunks.push(bytes);}
  const input=packet.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if(input.artifactSha256!==loadedArtifactSha256)throw new Error("ARTIFACT_MANIFEST_PIN_MISMATCH");
  const sha=digest(input);
  if(action==="--preflight")console.log(canonical({packetSha256:sha,packet:input,...await previewPaintV2(input.command)}));
  else{
    if(arg!==sha)throw new Error("PACKET_SHA_MISMATCH");
    console.log(canonical(await withReleaseLease(async()=>{
      assertLoadedArtifactIdentity(true);await assertArtifactCompatibility(prisma);
      return paintV2(input.command,{id:`agent:${input.agent}`,name:input.agent});
    })));
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
