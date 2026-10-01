import {describe,it,expect} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {execFileSync,spawnSync} from "node:child_process";

const app=process.cwd(),loader=resolve("src/lib/app-environment.ts"),tsx=resolve("node_modules/tsx/dist/loader.mjs");
function fixture(){
 const root=mkdtempSync(join(process.env.FLOOR_BOARDS_TEST_ROOT!,"environment-"));
 mkdirSync(join(root,"prisma"));writeFileSync(join(root,"package.json"),'{"name":"taco-oasis-floor-boards"}');writeFileSync(join(root,"prisma/schema.prisma"),"// synthetic root marker\n");
 return root;
}
function child(root:string,extra:Record<string,string|undefined>={}){
 const env={...process.env,...extra};delete env.NODE_OPTIONS;delete env.APP_ENV_PROOF;
 if(extra.APP_ENV_PROOF!==undefined)env.APP_ENV_PROOF=extra.APP_ENV_PROOF;
 return {cwd:root,env,encoding:"utf8" as const,timeout:15000};
}
const script=`const {loadAppEnvironment}=require(${JSON.stringify(loader)});try{loadAppEnvironment();console.log(process.env.APP_ENV_PROOF??"absent")}catch(e){console.error(e.message);process.exitCode=1}`;
describe("standalone existing-app environment",()=>{
 it("loads after relocation, preserves inherited precedence and allows an absent file",()=>{
  const root=fixture();try{
   expect(execFileSync(process.execPath,["--import",tsx,"-e",script],child(root)).trim()).toBe("absent");
   writeFileSync(join(root,".env"),'APP_ENV_PROOF="synthetic-file-value"\n');
   expect(execFileSync(process.execPath,["--import",tsx,"-e",script],child(root)).trim()).toBe("synthetic-file-value");
   expect(execFileSync(process.execPath,["--import",tsx,"-e",script],child(root,{APP_ENV_PROOF:"synthetic-inherited-value"})).trim()).toBe("synthetic-inherited-value");
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it("refuses a wrong root and sanitizes unreadable configuration errors",()=>{
  const root=fixture();try{
   mkdirSync(join(root,".env"));
   const bad=spawnSync(process.execPath,["--import",tsx,"-e",script],child(root));expect(bad.status).toBe(1);expect(bad.stderr.trim()).toBe("APP_ENVIRONMENT_UNREADABLE");
   writeFileSync(join(root,"package.json"),'{"name":"another-app"}');
   const wrong=spawnSync(process.execPath,["--import",tsx,"-e",script],child(root));expect(wrong.status).toBe(1);expect(wrong.stderr.trim()).toBe("APP_ENVIRONMENT_ROOT_REQUIRED");
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it("routes all audited standalone constructors through the configuration boundary",()=>{
  for(const file of ["scripts/readiness-check.ts","scripts/upgrade-home-base.ts","scripts/seed-position-map.ts","scripts/set-owner.ts","scripts/s14-station-colours.ts","scripts/s15-carne-relleno.ts","scripts/clear-employee-emails.ts","prisma/seed.ts"]){
   const source=readFileSync(join(app,file),"utf8");expect(source).toContain('import { PrismaClient } from "../src/lib/prisma-client"');expect(source).not.toContain('from "@prisma/client"');
  }
  expect(readFileSync(join(app,"src/lib/db.ts"),"utf8")).toContain('from "./prisma-client"');
  expect(readFileSync(join(app,"scripts/readiness-check.ts"),"utf8")).toContain('if (!managerSessionIsConfigured())');
 });
});
