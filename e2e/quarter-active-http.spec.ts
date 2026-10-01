import {test,expect,type Page} from "@playwright/test";
import {createRequire} from "node:module";
import type {} from "./fixtures/quarter-action";
import {PrismaClient} from "@prisma/client";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import type {PublicDayV2} from "../src/lib/quarter/client/day";
import {fromZonedTime} from "date-fns-tz";
import {safeDatabasePath} from "../scripts/test-db-path.cjs";
const date="2040-10-10",person="r0-http-person",shift="r0-http-source",origin="http://floor-boards.test:3100";
const controlPerson="r0-controls-person",controlShift="r0-controls-source";
let db:PrismaClient,activated=false;
const requests:string[]=[];
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{
  const root=process.env.FLOOR_BOARDS_TEST_ROOT!;
  const url=`file:${join(root,"e2e.db")}`;safeDatabasePath({...process.env,DATABASE_URL:url});
  db=new PrismaClient({datasources:{db:{url}}});
  const rows=await db.$queryRawUnsafe<{n:number}[]>("SELECT COUNT(*) n FROM PaintHour");expect(Number(rows[0].n)).toBe(0);
  const state=await db.$queryRawUnsafe<{phase:string}[]>("SELECT phase FROM QuarterSchema WHERE id=1");expect(state[0].phase).toBe("prepared");
  await db.employee.create({data:{id:person,externalId:person,firstName:"R0",lastName:"Synthetic"}});
  await db.shift.create({data:{id:shift,employeeId:person,board:"caja",date,sourcePosition:"Caja",startAt:fromZonedTime(`${date}T11:00:00`,"America/Chicago"),endAt:fromZonedTime(`${date}T13:00:00`,"America/Chicago")}});
  await db.employee.create({data:{id:controlPerson,externalId:controlPerson,firstName:"Controls",lastName:"Synthetic"}});
  await db.shift.create({data:{id:controlShift,employeeId:controlPerson,board:"caja",date,sourcePosition:"Caja",startAt:fromZonedTime(`${date}T11:00:00`,"America/Chicago"),endAt:fromZonedTime(`${date}T13:00:00`,"America/Chicago")}});
  // This is the already-guarded, disposable browser fixture only; no activation claim.
  await db.$executeRawUnsafe("UPDATE QuarterSchema SET phase='active',minReader=2,minWriter=2,activatedAtMs=1 WHERE id=1");activated=true;
});
test.afterAll(async()=>{
  if(activated){
    await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe("DELETE FROM PaintSegment WHERE paintHourId IN (SELECT id FROM PaintHour WHERE date=?)",date);
      await tx.$executeRawUnsafe("DELETE FROM PaintMutation WHERE date=?",date);
      await tx.$executeRawUnsafe("DELETE FROM PaintHour WHERE date=?",date);
      for(const id of requests)await tx.$executeRawUnsafe("DELETE FROM PaintCommandReceipt WHERE requestId=?",id);
      const remaining=await tx.$queryRawUnsafe<{n:number}[]>("SELECT COUNT(*) n FROM PaintHour");expect(Number(remaining[0].n)).toBe(0);
      await tx.$executeRawUnsafe("UPDATE QuarterSchema SET phase='prepared',minReader=1,minWriter=1,activatedAtMs=NULL WHERE id=1");
    });
    const removals=await db.shiftRemoval.findMany({where:{shiftId:{in:[shift,controlShift]}},select:{id:true}});
    await db.shiftRemovalEvent.deleteMany({where:{overrideId:{in:removals.map(r=>r.id)}}});
    await db.shiftRemoval.deleteMany({where:{id:{in:removals.map(r=>r.id)}}});
    await db.shift.deleteMany({where:{id:{in:[shift,controlShift]}}});await db.employee.deleteMany({where:{id:{in:[person,controlPerson]}}});
  }
  await db?.$disconnect();
});
async function openEditor(page:Page){
  await page.goto(`${origin}/?board=caja`);
  await page.getByTestId("compact-manager").click();await page.getByTestId("manager-code-input").fill("e2e-second-owner");await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("floor-board")).toHaveAttribute("data-role","manager");
  await page.getByTestId("compact-date").selectOption(date);await page.getByTestId("compact-view").selectOption("timeline");
  await expect(page.getByTestId("quarter-hour-editor")).toBeVisible();
}
test("ordinary HTTP real save loses response, then reload reconciles original receipt without duplicate mutation",async({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(crypto,"randomUUID",{value:undefined});Object.defineProperty(crypto,"subtle",{value:undefined});Object.defineProperty(window,"BroadcastChannel",{value:undefined});
  });
  await openEditor(page);expect(await page.evaluate(()=>isSecureContext)).toBe(false);
  await page.getByTestId("quarter-palette-family:green").click();await page.getByTestId(`quarter-cell-${shift}-11`).click();
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(1);
  let responseSaved=false;
  await page.route("**/api/v2/assignments/paint",async route=>{
    const body=route.request().postDataJSON();requests.push(body.requestId);
    const result=await route.fetch({url:route.request().url().replace("floor-boards.test","127.0.0.1")});expect(result.status()).toBe(200);responseSaved=true;await route.abort("failed");
  });
  await page.getByTestId("quarter-save").click();await expect.poll(()=>responseSaved).toBe(true);
  await expect(page.getByTestId("quarter-draft-status")).toContainText(/sin confirmar|unconfirmed/);
  const before=await db.$queryRawUnsafe<{n:number}[]>("SELECT COUNT(*) n FROM PaintMutation WHERE requestId=?",requests[0]);expect(Number(before[0].n)).toBeGreaterThan(0);
  await page.unroute("**/api/v2/assignments/paint");await openEditor(page);
  await expect(page.getByTestId("quarter-draft-status")).toContainText(/Guardado|Saved/);
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(0);
  const after=await db.$queryRawUnsafe<{n:number}[]>("SELECT COUNT(*) n FROM PaintMutation WHERE requestId=?",requests[0]);expect(after).toEqual(before);
  const retained=await page.evaluate(()=>new Promise<{generations:number;state:string;requestId:string}>((resolve,reject)=>{
    const r=indexedDB.open("taco-oasis-paint-drafts");r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const tx=r.result.transaction(["generations","submissions"]),g=tx.objectStore("generations").getAll(),s=tx.objectStore("submissions").getAll();
      tx.oncomplete=()=>{resolve({generations:g.result.length,state:s.result[0].state,requestId:s.result[0].requestId});r.result.close();};
    };
  }));
  expect(retained).toMatchObject({state:"confirmed",requestId:requests[0]});expect(retained.generations).toBeGreaterThan(1);
});


test("ordinary HTTP same-tab retry honors a known receipt without resubmitting",async({page})=>{
  await openEditor(page);
  await page.getByTestId("quarter-palette-family:green").click();await page.getByTestId(`quarter-cell-${shift}-12`).click();
  let saves=0;
  await page.route("**/api/v2/assignments/paint",async route=>{
    requests.push(route.request().postDataJSON().requestId);saves++;
    const response=await route.fetch({url:route.request().url().replace("floor-boards.test","127.0.0.1")});
    expect(response.status()).toBe(200);await route.abort("failed");
  });
  await page.getByTestId("quarter-save").click();
  await expect(page.getByTestId("quarter-draft-status")).toContainText(/sin confirmar|unconfirmed/);
  await page.getByTestId("quarter-save").click();
  await expect(page.getByTestId("quarter-draft-status")).toHaveText(/Guardado\.|Saved\./);
  await expect(page.getByTestId("quarter-private-preview")).toHaveCount(0);expect(saves).toBe(1);
});

test("ordinary HTTP failed retention keeps the first in-memory proposal until explicit retry",async({page})=>{
  await openEditor(page);
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(...args:Parameters<IDBObjectStore["add"]>){if(this.name==="generations")throw new DOMException("Synthetic quota fault","QuotaExceededError");return original.apply(this,args);};
    Object.assign(window,{restoreDraftAdds:()=>{IDBObjectStore.prototype.add=original;}});
  });
  await page.getByTestId("quarter-palette-family:purple").click();await page.getByTestId(`quarter-cell-${shift}-11`).click();
  await expect(page.getByTestId("quarter-draft-status")).toContainText(/No retenido|Not retained/);
  const memory=page.getByRole("alert").filter({has:page.locator("details")});
  const before=await memory.locator("pre").textContent();
  await page.getByTestId("quarter-palette-family:green").click();
  await expect(page.getByTestId(`quarter-cell-${shift}-12`)).toBeDisabled();
  expect(await memory.locator("pre").textContent()).toBe(before);await expect(page.getByTestId("quarter-save")).toBeDisabled();
  await page.evaluate(()=>(window as unknown as {restoreDraftAdds:()=>void}).restoreDraftAdds());
  await memory.getByRole("button",{name:/Reintentar retención|Retry retention/}).click();
  await expect(page.getByTestId("quarter-private-preview")).toContainText("purple");
  await expect(memory).toHaveCount(0);
});

test("ordinary HTTP receipt cleanup failure keeps a newer tab intent visible and retained",async({page,context})=>{
  await openEditor(page);const newer=await context.newPage();await openEditor(newer);
  await page.getByTestId("quarter-palette-family:green").click();await page.getByTestId(`quarter-cell-${shift}-11`).click();
  let release:()=>void=()=>{};const responseGate=new Promise<void>(resolve=>{release=resolve;});let waiting=false;
  await page.route("**/api/v2/assignments/paint",async route=>{
    requests.push(route.request().postDataJSON().requestId);waiting=true;await responseGate;
    const response=await route.fetch({url:route.request().url().replace("floor-boards.test","127.0.0.1")});await route.fulfill({response});
  });
  try{
    await page.getByTestId("quarter-save").click();await expect.poll(()=>waiting).toBe(true);
    await newer.getByRole("button",{name:/Revisar almacenamiento|Review retained work/}).click();
    await newer.getByTestId("quarter-palette-family:purple").click();await newer.getByTestId(`quarter-cell-${shift}-12`).click();
    await expect(newer.getByTestId("quarter-private-preview")).toHaveCount(2);
    await page.evaluate(()=>{
      const original=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore["put"]>){if(this.name==="submissions")this.transaction.abort();return original.apply(this,args);};
      Object.assign(window,{restoreDraftPuts:()=>{IDBObjectStore.prototype.put=original;}});
    });
    release();await expect(page.getByTestId("quarter-draft-status")).toContainText(/limpieza local pendiente|local cleanup pending/);
    await page.getByRole("button",{name:/Revisar almacenamiento|Review retained work/}).click();
    await expect(page.getByTestId("quarter-private-preview")).toHaveCount(1);
    await expect(page.getByTestId("quarter-private-preview")).toContainText("purple");
    await page.evaluate(()=>(window as unknown as {restoreDraftPuts:()=>void}).restoreDraftPuts());
    await page.getByTestId("quarter-save").click();
    await expect(page.getByTestId("quarter-draft-status")).toHaveText(/Guardado\.|Saved\./);
    await expect(page.getByTestId("quarter-private-preview")).toHaveCount(1);
    await expect(page.getByTestId("quarter-save")).toBeDisabled();
    await openEditor(newer);await expect(newer.getByTestId("quarter-private-preview")).toHaveCount(1);
    await expect(newer.getByRole("alert").filter({hasText:"SAVED_COMMAND_CHANGED_EXPECTATIONS"})).toHaveCount(1);
  }finally{release();await newer.close();}
});


test("ordinary HTTP retained whole-shift action replays exact bytes after response loss and reload",async({page})=>{
 const requireBundle=createRequire(process.cwd()+"/package.json");
 const {buildSync}=createRequire(requireBundle.resolve("tsx/package.json"))("esbuild") as {buildSync(options:Record<string,unknown>):{outputFiles:{text:string}[]}};
 const bundle=buildSync({entryPoints:["e2e/fixtures/quarter-action.ts"],bundle:true,write:false,platform:"browser",define:{"process.env.NODE_ENV":'"production"'}}).outputFiles[0].text;
 await page.goto(`${origin}/__quarter-action-fixture`);await page.addScriptTag({content:bundle});
 const bodies:string[]=[];
 await page.route("**/api/v2/assignments/operations",async route=>{
  const raw=route.request().postData()!;bodies.push(raw);requests.push(JSON.parse(raw).requestId);
  const result=await route.fetch({url:route.request().url().replace("floor-boards.test","127.0.0.1")});expect(result.status()).toBe(200);await route.abort("failed");
 });
 expect(await page.evaluate(()=>window.quarterActionProof.save())).toMatchObject({status:"unconfirmed"});
 const retained=await page.evaluate(()=>window.quarterActionProof.pending());expect(retained).toHaveLength(1);expect(retained[0].value.requestBytes).toBe(bodies[0]);
 const requestId=JSON.parse(bodies[0]).requestId;
 const before=await db.$queryRawUnsafe<{n:number}[]>("SELECT COUNT(*) n FROM PaintMutation WHERE requestId=?",requestId);expect(Number(before[0].n)).toBeGreaterThan(0);
 await page.unroute("**/api/v2/assignments/operations");await page.reload();await page.addScriptTag({content:bundle});
 await page.route("**/api/v2/assignments/operations",async route=>{bodies.push(route.request().postData()!);await route.continue();});
 expect(await page.evaluate(()=>window.quarterActionProof.recover())).toMatchObject({status:"saved"});
 expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);expect(await page.evaluate(()=>window.quarterActionProof.pending())).toEqual([]);
 expect(await db.$queryRawUnsafe("SELECT COUNT(*) n FROM PaintMutation WHERE requestId=?",requestId)).toEqual(before);
});

function trackControls(page:Page){
 const legacy:string[]=[];
 page.on("request",request=>{
  if(["GET","HEAD"].includes(request.method()))return;
  if(/\/api\/v2\/(assignments\/(paint|operations)|shift-removals)$/.test(request.url())){
   const body=request.postDataJSON();if(body?.requestId)requests.push(body.requestId);
  }
  if(/\/api\/(assignments|admin\/seat-plan|shift-removals)(\/|$)/.test(request.url()))legacy.push(request.url());
 });
 return legacy;
}
async function apiDay(page:Page){
 const login=await page.request.post(`${origin}/api/managers`,{data:{code:"e2e-second-owner"}});expect(login.ok()).toBe(true);
 const {sessionToken}=await login.json();const headers={"x-manager-session":sessionToken};
 const result=await page.request.get(`${origin}/api/v2/boards/caja/days/${date}`,{headers});expect(result.ok()).toBe(true);
 return {day:await result.json() as PublicDayV2,headers};
}
async function desk(page:Page,tab:string){
 await page.goto(`${origin}/back-office`);await page.getByTestId("back-office-code").fill("e2e-second-owner");
 await page.getByTestId("back-office-submit").click();await expect(page.getByTestId("back-office-app")).toBeVisible();
 await page.getByTestId(`back-office-tab-${tab}`).click();
}

test("active floor whole-shift placement, swap and clear use retained V2 controls",async({page})=>{
 const legacy=trackControls(page);await openEditor(page);
 await page.getByTestId("compact-view").selectOption("board");await page.getByTestId("compact-hour").selectOption("11");
 await page.getByTestId(`available-${controlPerson}`).click();
 const assigned=page.waitForResponse(r=>r.url().endsWith("/api/v2/assignments/paint")&&r.request().method()==="PUT");
 await page.getByTestId("station-yellow").click();expect((await assigned).status()).toBe(200);
 await expect(page.getByTestId("assignee-yellow")).toContainText("Controls");
 const placed=(await apiDay(page)).day.hours.filter(h=>h.shiftId===controlShift);
 expect(placed.flatMap(h=>h.intervals).filter(i=>i.state==="assigned").every(i=>i.stationId==="yellow")).toBe(true);
 expect(placed.flatMap(h=>h.intervals).reduce((n,i)=>n+(i.state==="assigned"?(Date.parse(i.endAt)-Date.parse(i.startAt))/60000:0),0)).toBe(120);
 await page.getByTestId("assignee-green1").click();
 const swapped=page.waitForResponse(r=>r.url().endsWith("/api/v2/assignments/operations")&&r.request().method()==="POST");
 await page.getByTestId("assignee-yellow").click();const swap=await swapped;expect(swap.status()).toBe(200);expect(swap.request().postDataJSON().operation).toBe("swap");
 await expect(page.getByTestId("assignee-green1")).toContainText("Controls");await expect(page.getByTestId("assignee-yellow")).toContainText("R0");
 const erased=page.waitForResponse(r=>r.url().endsWith("/api/v2/assignments/paint")&&r.request().method()==="PUT");
 await page.getByTestId("clear-yellow").click();expect((await erased).status()).toBe(200);await expect(page.getByTestId("assignee-yellow")).toHaveCount(0);
 const day=(await apiDay(page)).day;
 expect(day.hours.find(h=>h.shiftId===shift&&h.hourStart===fromZonedTime(`${date}T11:00:00`,"America/Chicago").toISOString())?.intervals.every(i=>i.state==="erased")).toBe(true);
 expect(legacy).toEqual([]);
});

test("active back-office seat save and mixed-hour refusal preserve exact intervals",async({page})=>{
 const legacy=trackControls(page);await desk(page,"seats");await page.getByTestId("seat-date").fill(date);
 await expect(page.getByTestId("seat-shift").locator(`option[value="${controlShift}"]`)).toHaveCount(1);
 await page.getByTestId("seat-shift").selectOption(controlShift);await page.getByTestId("seat-station").selectOption("blue");
 const saved=page.waitForResponse(r=>r.url().endsWith("/api/v2/assignments/paint")&&r.request().method()==="PUT");
 await page.getByTestId("seat-save").click();expect((await saved).status()).toBe(200);
 await expect(page.getByTestId("back-office-toast")).toBeVisible();
 const {day,headers}=await apiDay(page),requestId=randomUUID();requests.push(requestId);
 const response=await page.request.put(`${origin}/api/v2/assignments/paint`,{headers:{...headers,"Content-Type":"application/vnd.floor-boards.paint-v2+json","X-Floor-Boards-Protocol":"2"},data:{protocol:2,requestId,capabilitySha256:day.capabilitySha256,board:"caja",date,
  expected:{databaseEpoch:day.databaseEpoch,worldRevision:day.worldRevision},sources:day.sources.filter(s=>s.shiftId===controlShift),hours:day.hours.filter(h=>h.shiftId===controlShift).map(h=>({shiftId:h.shiftId,hourStart:h.hourStart,revision:h.revision,...(h.revision===null?{legacySha256:h.legacySha256}:{})})),
  intents:[{shiftId:controlShift,quarter:"12:15",granularity:"quarter",action:"station",stationId:"purple1"}]}});expect(response.status()).toBe(200);
 const before=(await apiDay(page)).day;
 // Reselect the tab to load the acknowledged mixed world through the real loader.
 await page.getByTestId("back-office-tab-turnos").click();await page.getByTestId("back-office-tab-seats").click();await page.getByTestId("seat-date").fill(date);
 await expect(page.getByTestId("seat-shift").locator(`option[value="${controlShift}"]`)).toHaveCount(1);
 await page.getByTestId("seat-shift").selectOption(controlShift);await page.getByTestId("seat-station").selectOption("yellow");
 let writes=0;page.on("request",r=>{if(r.method()==="PUT"&&r.url().endsWith("/api/v2/assignments/paint"))writes++;});
 await page.getByTestId("seat-save").click();await expect(page.getByTestId("back-office-error")).toContainText("HOUR_NEEDS_QUARTER");
 expect(writes).toBe(0);expect((await apiDay(page)).day.hours).toEqual(before.hours);expect(legacy).toEqual([]);
});

test("active removal and restore show factual minutes and preserve the mixed saved intervals",async({page})=>{
 const legacy=trackControls(page),before=(await apiDay(page)).day.hours.filter(h=>h.shiftId===controlShift);
 const intervals=before.flatMap(h=>h.intervals).map(({startAt,endAt,state,stationId,seatNumber})=>({startAt,endAt,state,stationId,seatNumber}));
 await desk(page,"turnos");await page.getByTestId("turnos-date").fill(date);await page.getByTestId("shift-removal-toggle").click();
 await page.getByTestId(`shift-removal-row-${controlShift}`).getByRole("button",{name:"Quitar turno",exact:true}).click();
 await expect(page.getByTestId("shift-removal-confirm")).toContainText("120 minutos futuros");
 await page.getByTestId("shift-removal-reason").fill("Synthetic interval preservation");
 const removed=page.waitForResponse(r=>r.url().endsWith("/api/v2/shift-removals")&&r.request().method()==="POST");
 await page.getByTestId("shift-removal-submit").click();expect((await removed).status()).toBe(200);
 await expect(page.getByTestId("shift-removal-confirm")).toHaveCount(0);
 const entry=await db.shiftRemoval.findUniqueOrThrow({where:{shiftId:controlShift}}),card=page.getByTestId(`removed-shift-${entry.id}`);
 await expect(card).toContainText("120 minutos guardadas");await expect(page.getByTestId(`shift-removal-row-${controlShift}`)).toHaveCount(0);
 await card.getByRole("button",{name:"Restaurar con posiciones",exact:true}).click();
 await page.getByTestId("shift-removal-reason").fill("Synthetic original intervals restore");
 const restored=page.waitForResponse(r=>r.url().endsWith("/api/v2/shift-removals")&&r.request().method()==="POST");
 await page.getByTestId("shift-removal-submit").click();expect((await restored).status()).toBe(200);
 await expect(page.getByTestId(`shift-removal-row-${controlShift}`)).toBeVisible();
 const actual=(await apiDay(page)).day.hours.filter(h=>h.shiftId===controlShift).flatMap(h=>h.intervals).map(({startAt,endAt,state,stationId,seatNumber})=>({startAt,endAt,state,stationId,seatNumber}));
 expect(actual).toEqual(intervals);expect(legacy).toEqual([]);
});
