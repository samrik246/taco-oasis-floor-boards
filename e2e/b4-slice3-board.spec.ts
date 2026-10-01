import path from "node:path";
import { mkdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { chicagoDateTime } from "../src/lib/time";
import type { DayBoardDto, ShiftDto } from "../src/components/board/types";
const date=formatInTimeZone(new Date(),"America/Chicago","yyyy-MM-dd");
const at=(time:string)=>chicagoDateTime(date,time).toISOString();
for(const board of ["caja","cocina"] as const) for(const locale of ["es","en"] as const){
 test(`${board} ${locale}: backup, Pintar counts, page palette and press feedback`,async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await page.clock.install({time:new Date(at("4:00 pm"))});
  await page.addInitScript(value=>localStorage.setItem("taco-oasis-locale-v1",value),locale);
  await page.route("**/api/managers",async route=>{
   const response=await route.fetch();const body=await response.json();await route.fulfill({response,json:{...body,idleMs:120_000}});
  });
  let writes=0;
  page.on("request",request=>{if(request.url().includes("/api/assignments")&&request.method()!=="GET")writes++;});
  let payload:DayBoardDto;
  await page.route(`**/api/boards/${board}/days/*`,async route=>{
   const response=await route.fetch();if(!response.ok()){await route.fulfill({response});return;}
   const original:DayBoardDto=await response.json();
   const station=original.stations[0]!;
   const shift=(id:string,position:string):ShiftDto=>({id,date,board,sourcePosition:position,startAt:at("4:00 pm"),endAt:at("10:00 pm"),employee:{id,firstName:"Example",lastName:id,email:null},assignments:[]});
   const seated=shift("seated",board==="caja"?"Caja":"Cocina");
   seated.assignments=Array.from({length:6},(_,i)=>({id:`a${i}`,stationId:station.id,hourStart:chicagoDateTime(date,`${4+i}:00 pm`).toISOString(),hourEnd:chicagoDateTime(date,`${5+i}:00 pm`).toISOString(),seatNumber:1}));
   payload={...original,shifts:[seated,shift("unpainted",board==="caja"?"Caja":"Cocina")],overlays:[],breaks:[{employeeId:"seated",shiftId:"seated",startAt:at("5:00 pm"),endAt:at("5:15 pm")}],auxiliaryShifts:[shift("backup","Caja - GM"),shift("other","Produccion")]};
   await route.fulfill({response,json:payload});
  });
  await page.goto(`/?board=${board}`);
  const backup=page.getByTestId("auxiliary-panel"),toggle=page.getByTestId("auxiliary-toggle");
  await expect(toggle).toContainText(locale==="es"?"REFUERZOS · 2":"BACKUP · 2");
  await expect(backup).toContainText("Caja - GM");
  const schedule=await page.getByTestId("schedule-panel").boundingBox(),aux=await backup.boundingBox();
  expect(aux!.y).toBeGreaterThanOrEqual(schedule!.y+schedule!.height);
  const station=payload!.stations[0]!.id;
  await expect(page.getByTestId(`schedule-block-${station}-18`)).toHaveAttribute("colspan","4");
  await page.clock.fastForward(20_500);await expect(toggle).toHaveAttribute("aria-expanded","false");
  await toggle.click();await expect(toggle).toHaveAttribute("aria-expanded","true");
  await page.clock.fastForward(21_000);await expect(toggle).toHaveAttribute("aria-expanded","true");
  await toggle.evaluate(element=>(element as HTMLElement).blur());
  await page.getByTestId("compact-manager").click();await page.getByTestId("manager-code-input").fill("8642");await page.getByTestId("manager-unlock-submit").click();
  await expect(page.getByTestId("manager-color-editor")).toBeVisible();
  await expect(page.getByTestId("paint-headcount-16")).toHaveText("2");
  await expect(page.locator('[data-testid="paint-row-backup"]')).toHaveCount(0);
  const ids=await page.getByTestId("paint-palette").locator('button[data-testid^="paint-palette-"]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-testid")));
  const final=page.getByTestId(`paint-palette-${payload!.stations.at(-1)!.id}`);
  await final.scrollIntoViewIfNeeded();await expect(final).toBeInViewport({ratio:1});
  expect(await page.evaluate(()=>window.scrollY)).toBeGreaterThan(100);
  const palette=await page.getByTestId("paint-palette").evaluate(element=>({client:element.clientHeight,scroll:element.scrollHeight,overflow:getComputedStyle(element).overflowY}));
  expect(palette.scroll).toBeLessThanOrEqual(palette.client+1);expect(palette.overflow).toBe("visible");
  const screens=path.join(process.env.FLOOR_BOARDS_TEST_ROOT!,"b4-slice3-screens");mkdirSync(screens,{recursive:true});
  await page.screenshot({path:path.join(screens,`${board}_${locale}_palette_end.png`)});
  await page.reload();await expect(page.getByTestId("manager-color-editor")).toBeVisible();
  expect(await page.getByTestId("paint-palette").locator('button[data-testid^="paint-palette-"]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-testid")))).toEqual(ids);
  const refresh=page.getByTestId("refresh-day");await refresh.scrollIntoViewIfNeeded();
  const box=await refresh.boundingBox();await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();
  expect(await refresh.evaluate(element=>getComputedStyle(element).filter)).toBe("brightness(0.78)");
  await page.mouse.up();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(screens,`${board}_${locale}_pintar.png`),fullPage:true});
  expect(writes).toBe(0);
 });
}
