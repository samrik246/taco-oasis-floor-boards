import {execFileSync} from "node:child_process";
import {mkdir,writeFile,rename,unlink} from "node:fs/promises";
import path from "node:path";
import {quarterAppDir} from "./lease";
import {assertLoadedArtifactIdentity,loadedArtifactSha256} from "./artifact";
import {canonical} from "./schema";
/** A loaded importer declares itself before waiting. Replacing files never refreshes this pin. */
export async function importerIdentity(kind:"folder"|"hourly"){
  assertLoadedArtifactIdentity();
  const dir=path.join(quarterAppDir(),"var/quarter-importers");await mkdir(dir,{recursive:true});
  const file=path.join(dir,`${process.pid}.json`),started=execFileSync("ps",["-p",String(process.pid),"-o","lstart="],{encoding:"utf8"}).trim();
  const record={pid:process.pid,started,kind,artifactSha256:loadedArtifactSha256,state:"waiting"};
  async function state(value:string){assertLoadedArtifactIdentity();const temporary=`${file}.tmp`;await writeFile(temporary,canonical({...record,state:value}),{mode:0o600});await rename(temporary,file);}
  await state("waiting");
  return {check:()=>assertLoadedArtifactIdentity(Boolean(loadedArtifactSha256)),state,close:()=>unlink(file).catch(e=>{if(e.code!=="ENOENT")throw e;})};
}
