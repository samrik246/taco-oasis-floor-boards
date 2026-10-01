import {test,expect,type Page} from "@playwright/test";
import {PrismaClient} from "@prisma/client";
import {join} from "node:path";
import {fromZonedTime} from "date-fns-tz";
import {safeDatabasePath} from "../scripts/test-db-path.cjs";
const date="2040-10-10",person="r0-http-person",shift="r0-http-source",origin="http://floor-boards.test:3100";
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
    await db.shift.delete({where:{id:shift}});await db.employee.delete({where:{id:person}});
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
    await expect(newer.getByRole("alert")).toContainText("SAVED_COMMAND_CHANGED_EXPECTATIONS");
  }finally{release();await newer.close();}
});
