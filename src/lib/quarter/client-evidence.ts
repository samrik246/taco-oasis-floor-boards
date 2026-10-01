import {randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,rename} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {quarterAppDir} from "./lease";
import {assertArtifactSchema,loadedArtifactSha256} from "./artifact";
import {canonical,digest,QuarterRefused,quarterState,type QuarterDb} from "./schema";
const instant=z.iso.datetime(),id=z.string().min(1).max(160),hash=z.string().regex(/^[a-f0-9]{64}$/);
const origin=z.url().refine(value=>{const u=new URL(value);return ["http:","https:"].includes(u.protocol)&&u.origin===value;});
export const inventorySchema=z.strictObject({version:z.literal(1),synthetic:z.boolean(),revision:id,operatorId:id,enumeratedAt:instant,
  devices:z.array(z.strictObject({label:id,role:z.enum(["floor","wall","editor"]),origin,clientInstanceId:z.uuid(),board:z.enum(["caja","cocina"]),view:id,
    disposition:z.enum(["retained","retired"]),noReturnToFloor:z.boolean().optional()})).min(1).max(100)}).superRefine((v,c)=>{
    if(new Set(v.devices.map(d=>d.label)).size!==v.devices.length||new Set(v.devices.filter(d=>d.disposition==="retained").map(d=>d.clientInstanceId)).size!==v.devices.filter(d=>d.disposition==="retained").length||v.devices.some(d=>d.disposition==="retired"&&d.noReturnToFloor!==true))c.addIssue({code:"custom",message:"Duplicate device or incomplete retirement"});
});
export const measurementSchema=z.strictObject({challengeId:z.uuid(),clientInstanceId:z.uuid(),origin,role:z.enum(["floor","wall","editor"]),board:z.enum(["caja","cocina"]),clientBuildSha:z.string().regex(/^[a-f0-9]{40}$/),protocol:z.literal(2),cacheSchema:z.literal(2),draftDbVersion:z.literal(1),isSecureContext:z.boolean(),idbProbe:z.literal("commit-readback-ok"),legacyBoardCacheAbsent:z.literal(true),observedDatabaseEpoch:id,schemaFingerprint:hash});
const issueSchema=z.strictObject({action:z.literal("issue"),inventory:inventorySchema,label:id});
const answerSchema=z.strictObject({action:z.literal("answer"),measurement:measurementSchema,visible:z.strictObject({label:id,clientInstanceId:z.uuid(),board:z.enum(["caja","cocina"]),view:id,oldTabsClosed:z.literal(true),observedAt:instant})});
export const clientEvidenceBody=z.discriminatedUnion("action",[issueSchema,answerSchema]);
function refuse():never{throw new QuarterRefused("CLIENT_READBACK_MISSING_OR_STALE",409);}
/** Files are activation evidence; no new authoritative application table is introduced. */
export async function clientEvidence(raw:unknown,actorId:string,requestOrigin:string,db:QuarterDb,now=new Date()){
  const input=clientEvidenceBody.parse(raw),manifest=await assertArtifactSchema(db),state=await quarterState(db);if(!state)refuse();
  const dir=path.join(quarterAppDir(),"var/quarter-clients");await mkdir(dir,{recursive:true});
  if(input.action==="issue"){
    const inventory=input.inventory,device=inventory.devices.find(d=>d.label===input.label);
    if(!device||device.disposition!=="retained"||device.origin!==requestOrigin||inventory.operatorId!==actorId||+new Date(inventory.enumeratedAt)>+now||inventory.synthetic!==Boolean(process.env.FLOOR_BOARDS_TEST_ROOT))refuse();
    const inventorySha256=digest(inventory),challengeId=randomUUID();
    const challenge={version:1,challengeId,issuedAt:now.toISOString(),operatorId:actorId,device,inventorySha256,synthetic:inventory.synthetic,
      artifactSha256:loadedArtifactSha256,clientBuildSha:manifest.sourceSha,staticSha256:manifest.staticSha256,databaseEpoch:state.databaseEpoch,schemaFingerprint:manifest.schemaSha256};
    try{await writeFile(path.join(dir,`inventory-${inventorySha256}.json`),canonical(inventory),{flag:"wx",mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
    await writeFile(path.join(dir,`${challengeId}.challenge.json`),canonical(challenge),{flag:"wx",mode:0o600});return challenge;
  }
  const m=input.measurement,source=path.join(dir,`${m.challengeId}.challenge.json`),used=path.join(dir,`${m.challengeId}.used.json`);
  // Atomic claim is consumed even when a callback fails validation. It cannot be replayed.
  try{await rename(source,used);}catch{refuse();}
  const challenge=JSON.parse(await readFile(used,"utf8")),device=challenge.device;
  if(challenge.operatorId!==actorId||challenge.artifactSha256!==loadedArtifactSha256||challenge.databaseEpoch!==state.databaseEpoch||challenge.schemaFingerprint!==manifest.schemaSha256||+now<+new Date(challenge.issuedAt)||+now-+new Date(challenge.issuedAt)>120000||requestOrigin!==device.origin||
    m.clientInstanceId!==device.clientInstanceId||m.origin!==device.origin||m.role!==device.role||m.board!==device.board||m.clientBuildSha!==manifest.sourceSha||m.observedDatabaseEpoch!==state.databaseEpoch||m.schemaFingerprint!==manifest.schemaSha256||
    input.visible.label!==device.label||input.visible.clientInstanceId!==device.clientInstanceId||input.visible.board!==device.board||input.visible.view!==device.view||+new Date(input.visible.observedAt)<+new Date(challenge.issuedAt)||+new Date(input.visible.observedAt)>+now)refuse();
  const record={version:1,synthetic:challenge.synthetic,challengeId:m.challengeId,issuedAt:challenge.issuedAt,receivedAt:now.toISOString(),operatorId:actorId,inventorySha256:challenge.inventorySha256,
    artifactSha256:loadedArtifactSha256,staticSha256:manifest.staticSha256,measurement:m,visible:input.visible,label:device.label,matched:true};
  const receipt={...record,recordSha256:digest(record)};
  await writeFile(path.join(dir,`${m.challengeId}.receipt.json`),canonical(receipt),{flag:"wx",mode:0o600});return receipt;
}
