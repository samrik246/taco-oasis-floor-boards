import {createHash} from "node:crypto";
import {existsSync,readFileSync,lstatSync,readlinkSync,realpathSync,readdirSync} from "node:fs";
import path from "node:path";
import {artifactAppDir} from "./artifact-root";
import {QuarterRefused,type QuarterDb,MIGRATION_SHA256} from "./schema";
import managedRoots from "./artifact-roots.json";
import {schemaFingerprint} from "./preservation";
export type ArtifactManifest={version:1;scope:"source-check"|"runtime";role:"QP_COMPAT_R0"|"QP_UI_Q1";sourceSha:string;qualification:"candidate";versions:{reader:2;writer:2;receipt:2;draft:1;cache:2;schema:2};quarterUi:boolean;blockNotes:boolean;
  files:([string,"file",string,number]|[string,"link",string])[];treeSha256:string;staticSha256:string;buildIdSha256:string;schemaSha256:string;migrationSha256:string;registrySha256:string;controllerSha256:string;timerSha256:string;managedRoots:string[]};
const hash=(text:Buffer|string)=>createHash("sha256").update(text).digest("hex");
const fileHash=(file:string)=>hash(readFileSync(file));
// Captured when this module is loaded, BEFORE an importer waits for the release lease.
const app=artifactAppDir(),manifestPath=path.join(app,"QUARTER_ARTIFACT.json");
export const loadedArtifactSha256=existsSync(manifestPath)?fileHash(manifestPath):null;
let verified:ArtifactManifest|null=null;
export function assertLoadedArtifactIdentity(required=false):void {
  const current=existsSync(manifestPath)?fileHash(manifestPath):null;
  if(current!==loadedArtifactSha256)throw new QuarterRefused("LOADED_ARTIFACT_CHANGED",503);
  if(required&&!current)throw new QuarterRefused("ARTIFACT_MANIFEST_REQUIRED",503);
}
function inventory(root:string,rel:string,rows:ArtifactManifest["files"]){
  if(rel===".next/cache"||rel.startsWith(".next/cache/")||rel.split("/").includes("__pycache__"))return;
  if(path.isAbsolute(rel)||rel.split("/").some(p=>p===".."||p.startsWith(".env")))throw new QuarterRefused("ARTIFACT_PATH_FORBIDDEN",503);
  const name=path.join(root,rel),stat=lstatSync(name);
  if(stat.isSymbolicLink()){
    if(!rel.startsWith("node_modules/")||!realpathSync(name).startsWith(path.join(root,"node_modules")+path.sep))throw new QuarterRefused("ARTIFACT_LINK_FORBIDDEN",503);
    rows.push([rel,"link",readlinkSync(name)]);
  }else if(stat.isFile())rows.push([rel,"file",fileHash(name),stat.mode&0o7777]);
  else if(stat.isDirectory())for(const child of readdirSync(name))inventory(root,`${rel}/${child}`,rows);
  else throw new QuarterRefused("ARTIFACT_SPECIAL_FILE",503);
}
export function verifiedArtifact():ArtifactManifest {
  assertLoadedArtifactIdentity(true);if(verified)return verified;
  const m=JSON.parse(readFileSync(manifestPath,"utf8")) as ArtifactManifest;
  if(m.version!==1||!["QP_COMPAT_R0","QP_UI_Q1"].includes(m.role)||m.versions?.reader!==2||m.versions.writer!==2||m.versions.receipt!==2||m.versions.draft!==1||m.versions.cache!==2||m.versions.schema!==2||m.migrationSha256!==MIGRATION_SHA256||!Array.isArray(m.managedRoots))throw new QuarterRefused("ARTIFACT_PROTOCOL_INCOMPATIBLE",503);
  if(JSON.stringify(m.managedRoots)!==JSON.stringify([...managedRoots,"node_modules"])||(process.env.NEXT_PUBLIC_QUARTER_SOURCE_SHA&&m.sourceSha!==process.env.NEXT_PUBLIC_QUARTER_SOURCE_SHA))throw new QuarterRefused("ARTIFACT_SOURCE_MISMATCH",503);
  const rows:ArtifactManifest["files"]=[];for(const root of m.managedRoots)inventory(app,root,rows);
  rows.sort((a,b)=>Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0])));
  if(hash(JSON.stringify(rows))!==m.treeSha256||JSON.stringify(rows)!==JSON.stringify(m.files))throw new QuarterRefused("ARTIFACT_TREE_MISMATCH",503);
  const pins={controllerSha256:"scripts/quarter_release.py",registrySha256:"src/lib/quarter/preservation-columns.json",timerSha256:"src/lib/breaks/auto-pick.ts",buildIdSha256:".next/BUILD_ID"} as const;
  for(const [key,rel] of Object.entries(pins))if(m[key as keyof typeof pins]!==fileHash(path.join(app,rel)))throw new QuarterRefused("ARTIFACT_INTERNAL_PIN_MISMATCH",503);
  if(hash(JSON.stringify(rows.filter(row=>row[0].startsWith(".next/static/"))))!==m.staticSha256)throw new QuarterRefused("ARTIFACT_STATIC_PIN_MISMATCH",503);
  return verified=m;
}
export async function assertArtifactSchema(db:QuarterDb):Promise<ArtifactManifest>{
  const m=verifiedArtifact();if(await schemaFingerprint(db)!==m.schemaSha256)throw new QuarterRefused("ARTIFACT_SCHEMA_INCOMPATIBLE",503);return m;
}
