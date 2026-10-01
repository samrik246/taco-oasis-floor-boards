import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {mkdtemp,rm,mkdir,symlink,readdir} from "node:fs/promises";
import path from "node:path";
import type {QuarterDb} from "@/lib/quarter/schema";
const fake=vi.hoisted(()=>({app:"",source:"a".repeat(40),schema:"b".repeat(64),static:"c".repeat(64),artifact:"d".repeat(64)}));
vi.mock("@/lib/quarter/lease",()=>({quarterAppDir:()=>fake.app}));
vi.mock("@/lib/quarter/artifact",()=>({loadedArtifactSha256:fake.artifact,assertArtifactSchema:async()=>({sourceSha:fake.source,schemaSha256:fake.schema,staticSha256:fake.static})}));
vi.mock("@/lib/quarter/schema",async original=>({...await original<typeof import("@/lib/quarter/schema")>(),quarterState:async()=>({databaseEpoch:"synthetic-epoch"})}));
import {clientEvidence,clientRequestOrigin} from "@/lib/quarter/client-evidence";
const origin="http://floor-boards.test:3100",now=new Date("2038-10-12T12:00:00.000Z"),instance="11111111-1111-4111-8111-111111111111";
const db={} as QuarterDb;
function inventory(){return {version:1,synthetic:true,revision:"synthetic",operatorId:"operator",enumeratedAt:now.toISOString(),devices:[{label:"floor",role:"floor",origin,clientInstanceId:instance,board:"caja",view:"schedule",disposition:"retained"}]};}
function measurement(challengeId:string){return {action:"answer",measurement:{challengeId,clientInstanceId:instance,origin,role:"floor",board:"caja",clientBuildSha:fake.source,protocol:2,cacheSchema:2,draftDbVersion:1,isSecureContext:false,idbProbe:"commit-readback-ok",legacyBoardCacheAbsent:true,observedDatabaseEpoch:"synthetic-epoch",schemaFingerprint:fake.schema},visible:{label:"floor",clientInstanceId:instance,board:"caja",view:"schedule",oldTabsClosed:true,observedAt:new Date(+now+1000).toISOString()}};}
async function issue(){return clientEvidence({action:"issue",inventory:inventory(),label:"floor"},"operator",origin,db,now);}
describe("challenge-bound client activation evidence",()=>{
 let root:string;
 beforeEach(async()=>{root=await mkdtemp(path.join(process.env.FLOOR_BOARDS_TEST_ROOT!,"client-evidence-"));fake.app=path.join(root,"app");});
 afterEach(async()=>{await rm(root,{recursive:true,force:true});});
 it("binds the browser Origin to its HTTP Host even when the framework canonicalizes the request URL",()=>{
  expect(clientRequestOrigin(new Request("http://127.0.0.1:3100/api/v2/maintenance/clients",{headers:{origin,host:"floor-boards.test:3100"}}))).toBe(origin);
  for(const headers of ([{origin,host:"other.test:3100"},{origin:"null",host:"floor-boards.test:3100"},{host:"floor-boards.test:3100"}] as Record<string,string>[]))expect(()=>clientRequestOrigin(new Request("http://127.0.0.1:3100",{headers}))).toThrow("CLIENT_READBACK_MISSING_OR_STALE");
 });
 it("records the measured reply once and refuses challenge replay",async()=>{
  const challenge=await issue(),body=measurement(challenge.challengeId),received=new Date(+now+2000);
  const result=await clientEvidence(body,"operator",origin,db,received);
  expect(result).toMatchObject({matched:true,synthetic:true,measurement:{idbProbe:"commit-readback-ok",clientInstanceId:instance}});
  await expect(clientEvidence(body,"operator",origin,db,received)).rejects.toThrow("CLIENT_READBACK_MISSING_OR_STALE");
 });
 it.each(["future","expired","origin","operator","missing","duplicate"])("refuses %s inventory before issuing a challenge",async mode=>{
  const inv=inventory();
  if(mode==="future")inv.enumeratedAt=new Date(+now+1).toISOString();
  if(mode==="expired")inv.enumeratedAt=new Date(+now-900001).toISOString();
  if(mode==="origin")inv.devices[0].origin="http://other.test:3100";
  if(mode==="operator")inv.operatorId="another";
  if(mode==="missing")inv.devices[0].label="other";
  if(mode==="duplicate")inv.devices.push({...inv.devices[0],label:"duplicate"});
  await expect(clientEvidence({action:"issue",inventory:inv,label:"floor"},"operator",origin,db,now)).rejects.toThrow();
 });
 it.each(["build","epoch","instance","origin","visible","expired","future"])("consumes and refuses %s mismatched evidence",async mode=>{
  const challenge=await issue(),body=measurement(challenge.challengeId);
  if(mode==="build")body.measurement.clientBuildSha="f".repeat(40);
  if(mode==="epoch")body.measurement.observedDatabaseEpoch="changed";
  if(mode==="instance")body.measurement.clientInstanceId="22222222-2222-4222-8222-222222222222";
  if(mode==="origin")body.measurement.origin="http://other.test:3100";
  if(mode==="visible")body.visible.view="wall";
  if(mode==="future")body.visible.observedAt=new Date(+now+3000).toISOString();
  const at=new Date(+now+(mode==="expired"?120001:2000));
  await expect(clientEvidence(body,"operator",origin,db,at)).rejects.toThrow("CLIENT_READBACK_MISSING_OR_STALE");
  await expect(clientEvidence(measurement(challenge.challengeId),"operator",origin,db,new Date(+now+2000))).rejects.toThrow("CLIENT_READBACK_MISSING_OR_STALE");
 });
 it("refuses a linked evidence directory without writing through it",async()=>{
  const target=path.join(root,"elsewhere");await mkdir(target);await mkdir(fake.app);await symlink(target,path.join(fake.app,"var"));
  await expect(issue()).rejects.toThrow("CLIENT_READBACK_MISSING_OR_STALE");expect(await readdir(target)).toEqual([]);
 });
});
