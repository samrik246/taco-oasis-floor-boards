/** Persistent synthetic browser stores across actual runtime promotion. Never logs session tokens. */
import {chromium} from "@playwright/test";
import {createRequire} from "node:module";
import {readFileSync,writeFileSync,realpathSync} from "node:fs";
import path from "node:path";
import type {} from "./quarter-rehearsal-browser-client";
const [mode,profile,date,source,output,prior]=process.argv.slice(2);
const root=realpathSync(process.env.FLOOR_BOARDS_TEST_ROOT!);
if(!/^\/private\/tmp\/color-boards-test-[A-Za-z0-9]+$/.test(root)||!path.resolve(profile).startsWith(root+path.sep))throw new Error("SYNTHETIC_PROFILE_REQUIRED");
const requireBundle=createRequire(path.join(process.cwd(),"package.json"));
const {buildSync}=createRequire(requireBundle.resolve("tsx/package.json"))("esbuild") as {buildSync(o:Record<string,unknown>):{outputFiles:{text:string}[]}};
const bundle=buildSync({entryPoints:["scripts/quarter-rehearsal-browser-client.ts"],bundle:true,write:false,platform:"browser",define:{"process.env.NODE_ENV":'"production"'}}).outputFiles[0].text;
async function main(){
 const context=await chromium.launchPersistentContext(profile,{headless:true,args:["--host-resolver-rules=MAP floor-boards.test 127.0.0.1","--no-proxy-server"]});
 try{
  const page=await context.newPage();await page.goto("http://floor-boards.test:3100/__quarter-recovery-storage");await page.addScriptTag({content:bundle});
  if(await page.evaluate(()=>isSecureContext||typeof navigator.locks!=="undefined"))throw new Error("ORDINARY_HTTP_REQUIRED");
  let result:unknown;
  if(mode==="seed"){
   let receipt:unknown;
   await page.route("**/api/v2/assignments/paint",async route=>{
    const response=await route.fetch({url:route.request().url().replace("floor-boards.test","127.0.0.1")});
    if(response.status()!==200)throw new Error(`REHEARSAL_BROWSER_SAVE_FAILED:${response.status()}`);
    receipt=await response.json();await route.abort("failed");
   });
   const retained=await page.evaluate(({date,source})=>window.quarterRecovery.seed(date,source),{date,source});
   if(!receipt)throw new Error("ACKNOWLEDGED_BROWSER_WRITE_MISSING");
   result={retained,receipt,dump:await page.evaluate(()=>window.quarterRecovery.dump())};
  }else{
   const expected=JSON.parse(readFileSync(prior,"utf8")),dump=await page.evaluate(()=>window.quarterRecovery.dump());
   if(JSON.stringify(dump)!==JSON.stringify(expected.dump))throw new Error("RECOVERY_BROWSER_BYTES_CHANGED");
   result=mode==="reconcile"?{preserved:dump,reconciliation:await page.evaluate(scope=>window.quarterRecovery.reconcile(scope),expected.retained.scope),after:await page.evaluate(()=>window.quarterRecovery.dump())}:{preserved:dump};
  }
  writeFileSync(output,JSON.stringify(result)+"\n");
 }finally{await context.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
