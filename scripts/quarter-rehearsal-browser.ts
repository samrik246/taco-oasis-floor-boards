/** Persistent synthetic browser stores across actual runtime promotion. Never logs session tokens. */
import {chromium, expect, type Page} from "@playwright/test";
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
async function rawStores(page: Page) {
 return page.evaluate(async()=>{
  const stores=await new Promise<Record<string,unknown[]>>((resolve,reject)=>{
   const r=indexedDB.open("taco-oasis-paint-drafts",1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
    const db=r.result,names=Array.from(db.objectStoreNames);if(!names.length){db.close();resolve({});return;}
    const tx=db.transaction(names),rows:Record<string,unknown[]>={};
    for(const name of names){const q=tx.objectStore(name).getAll();q.onsuccess=()=>{rows[name]=q.result;};}
    tx.oncomplete=()=>{db.close();resolve(rows);};tx.onabort=()=>reject(tx.error);
   };
  });
  const legacy=Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith("taco-oasis-paint-draft-v1:")).sort().map(k=>[k,localStorage.getItem(k)]));
  return {stores,legacy,cache:localStorage.getItem("taco-oasis-last-board-v2")};
 });
}
async function actualBundle(page: Page) {
 const origin="http://floor-boards.test:3100", expected=mode==="bundle-seed"?null:JSON.parse(readFileSync(prior,"utf8"));
 // Inspect retained bytes before mounting the current artifact's actual editor.
 await page.route("**/__bundle-storage",r=>r.fulfill({status:200,contentType:"text/html",body:"<!doctype html><title>Synthetic retained storage</title>"}));
 await page.goto(origin+"/__bundle-storage");
 if(await page.evaluate(()=>isSecureContext||typeof navigator.locks!=="undefined"))throw new Error("ORDINARY_HTTP_REQUIRED");
 const before=expected?await rawStores(page):{stores:{},legacy:{},cache:null};
 if(expected)expect(before).toEqual(expected.after);
 if(mode==="bundle-offline") {writeFileSync(output,JSON.stringify({mode,before,after:before,offlinePreserved:true})+"\n");return;}
 const manifest=JSON.parse(readFileSync(path.join(process.cwd(),"QUARTER_ARTIFACT.json"),"utf8"));
 await page.addInitScript(()=>localStorage.setItem("taco-oasis-locale-v1","en"));
 await page.goto(origin+"/?board=caja&readback=1");
 await page.getByTestId("compact-manager").click();await page.getByTestId("manager-code-input").fill("quarter-rehearsal-owner");await page.getByTestId("manager-unlock-submit").click();
 await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role","manager");
 await page.getByTestId("compact-date").selectOption(date);await page.getByTestId("compact-view").selectOption("timeline");
 await expect(page.getByTestId("quarter-hour-editor")).toBeVisible();
 // The loaded page answers a challenge using its compiled CLIENT_BUILD_SHA.
 const panel=page.getByTestId("quarter-client-readback"),instance=panel.getByTestId("client-instance-id");await expect(instance).toHaveText(/^[a-f0-9-]{36}$/);
 const owner=await page.evaluate(async()=>{const r=await fetch("/api/managers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"quarter-rehearsal-owner"})});if(!r.ok)throw new Error("SYNTHETIC_LOGIN_FAILED");return (await r.json()).manager.id;});
 const label="synthetic-loaded-"+mode,inventory={version:1,synthetic:true,revision:mode+"-"+date,operatorId:owner,enumeratedAt:new Date().toISOString(),devices:[{label,role:"editor",origin,clientInstanceId:await instance.textContent(),board:"caja",view:"timeline",disposition:"retained"}]};
 await panel.locator('input[type="file"]').setInputFiles({name:"inventory.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(inventory))});
 await panel.getByLabel("Device label").fill(label);await panel.locator('input[type="checkbox"]').check();
 await panel.getByRole("button",{name:"Owner sign in"}).click();await page.getByTestId("manager-code-input").fill("quarter-rehearsal-owner");await page.getByTestId("manager-unlock-submit").click();
 const answer=page.waitForResponse(r=>r.url().endsWith("/api/v2/maintenance/clients")&&r.request().postDataJSON().action==="answer");
 await panel.getByRole("button",{name:"Record readback"}).click();const answered=await answer;expect(answered.status()).toBe(200);const measurement=await answered.json();
 expect(measurement.measurement.clientBuildSha).toBe(manifest.sourceSha);expect(measurement.staticSha256).toBe(manifest.staticSha256);
 expect(measurement.measurement.isSecureContext).toBe(false);
 const q1=manifest.role==="QP_UI_Q1";await expect(page.getByTestId("q1-zoom")).toHaveCount(q1?1:0);
 let receipt:unknown=null,newerIntentId:string|null=null;
 if(mode==="bundle-seed"){
  if(!q1)throw new Error("REAL_Q1_BUNDLE_REQUIRED");
  await page.getByTestId("quarter-palette-green1").click();await page.getByTestId("q1-hour-header-10").getByRole("button").click();await page.getByTestId("q1-zoom").click();
  await page.getByTestId(`quarter-cell-${source}-10-0`).click();await expect(page.getByTestId("quarter-private-preview")).toHaveCount(1);
  await page.route("**/api/v2/assignments/paint",async route=>{const r=await route.fetch({url:route.request().url().replace("floor-boards.test","127.0.0.1")});expect(r.status()).toBe(200);receipt=await r.json();await route.abort("failed");});
  await page.getByTestId("quarter-save").click();await expect(page.getByTestId("quarter-draft-status")).toContainText("unconfirmed");
  if(!receipt)throw new Error("REAL_UI_ACKNOWLEDGED_WRITE_REQUIRED");
  await page.getByTestId("quarter-palette-purple1").click();await page.getByTestId(`quarter-cell-${source}-10-30`).click();await expect(page.getByTestId("quarter-private-preview")).toHaveCount(2);
  const stored=await rawStores(page),heads=stored.stores.heads as {generationId:string}[],generations=stored.stores.generations as {generationId:string;envelope:{intents:{intentId:string;intent:{quarter:string}}[]}}[];
  newerIntentId=generations.find(g=>g.generationId===heads[0].generationId)!.envelope.intents.find(i=>i.intent.quarter==="10:30")!.intentId;
 }else{
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(1);
  await expect(page.getByTestId("quarter-private-preview")).toContainText("10:30");
  await expect(page.getByRole("alert").filter({hasText:"SAVED_COMMAND_CHANGED_EXPECTATIONS"})).toHaveCount(1);
  const stored=await rawStores(page),heads=stored.stores.heads as {generationId:string;pendingRequestId:string|null}[],generations=stored.stores.generations as {generationId:string;envelope:{intents:{intentId:string}[]}}[];
  expect(heads[0].pendingRequestId).toBeNull();
  newerIntentId=expected.newerIntentId;expect(generations.find(g=>g.generationId===heads[0].generationId)!.envelope.intents.map(i=>i.intentId)).toEqual([newerIntentId]);
  if(mode==="bundle-preserve")expect(stored.stores).toEqual(before.stores);
  receipt=expected.receipt;
 }
 await page.screenshot({path:output+".png",fullPage:true});
 writeFileSync(output,JSON.stringify({mode,role:manifest.role,sourceSha:manifest.sourceSha,measurement,before,after:await rawStores(page),receipt,newerIntentId})+"\n");
}

async function main(){
 const context=await chromium.launchPersistentContext(profile,{headless:true,args:["--host-resolver-rules=MAP floor-boards.test 127.0.0.1","--no-proxy-server"]});
 try{
  const page=await context.newPage();
  if(mode.startsWith("bundle-")){await actualBundle(page);return;}
  if(mode==="inspect")await context.route("**/*",route=>route.request().url()==="http://floor-boards.test:3100/__quarter-recovery-storage"
    ?route.fulfill({status:200,contentType:"text/html",body:"<!doctype html><title>Synthetic storage inspection</title>"}):route.abort());
  await page.goto("http://floor-boards.test:3100/__quarter-recovery-storage");await page.addScriptTag({content:bundle});
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
   if(JSON.stringify(dump)!==JSON.stringify(mode==="preserve"?expected.after:expected.dump))throw new Error("RECOVERY_BROWSER_BYTES_CHANGED");
   result=mode==="reconcile"?{preserved:dump,reconciliation:await page.evaluate(scope=>window.quarterRecovery.reconcile(scope),expected.retained.scope),after:await page.evaluate(()=>window.quarterRecovery.dump())}:{preserved:dump};
  }
  writeFileSync(output,JSON.stringify(result)+"\n");
 }finally{await context.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
