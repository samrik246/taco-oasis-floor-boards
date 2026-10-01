/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuxiliaryPanel } from "@/components/board/AuxiliaryPanel";
import { SchedulePanel } from "@/components/board/SchedulePanel";
import type { DayBoardDto, ShiftDto } from "@/components/board/types";
import { isAuxiliaryPosition, isMainBoardPosition } from "@/lib/board/auxiliary";
import { scheduledHeadcounts } from "@/lib/board/headcounts";
import { buildBlocksForHours } from "@/lib/schedule/build-schedule";
import { messagesFor } from "@/lib/i18n";
const date = "2026-09-30";
const at = (h: number, m=0) => new Date(Date.UTC(2026, 8, 30, h+5, m)).toISOString();
function shift(id: string, position="Caja", start=16, end=22): ShiftDto {
 return {id,date,board:"caja",sourcePosition:position,startAt:at(start),endAt:at(end),employee:{id,firstName:"Example",lastName:id,email:null},assignments:[]};
}
function day(): DayBoardDto {
 const row=shift("evening");
 row.assignments=Array.from({length:6},(_,i)=>({id:`a${i}`,stationId:"green1",hourStart:at(16+i),hourEnd:at(17+i),seatNumber:1}));
 return {board:"caja",date,stations:[{id:"green1",label:"Green 1",color:"green",sortOrder:1,maxConcurrent:1,priority:1}],shifts:[row],breaks:[{employeeId:row.employee.id,shiftId:row.id,startAt:at(17),endAt:at(17,15)}]};
}
describe("B4 auxiliary classification and independent scheduled counts",()=>{
 it("includes all current/legacy aliases and other work, excludes Catering and ordinary board work",()=>{
  for(const name of ["Caja - GM","Caja - UP Manager","GM","UP Manager","  caja -  gm ","Produccion","Picar Carne","Office"]) expect(isAuxiliaryPosition(name),name).toBe(true);
  for(const name of ["Catering Manager","Catering DRIVER","Caja Catering","Caja Manager","Cocina Guia Abrir","Caja - Regular"]) expect(isAuxiliaryPosition(name),name).toBe(false);
  expect(isMainBoardPosition("Catering Manager")).toBe(false);
  expect(isMainBoardPosition("Caja - GM")).toBe(false);
  expect(isMainBoardPosition("Caja Manager")).toBe(true);
 });
 it("counts unpainted, partial and split shifts once per person; excludes auxiliary/history/other dates",()=>{
  const input=day();input.shifts=[shift("one"),{...shift("split"),employee:shift("one").employee,startAt:at(17,30)},shift("unpainted","Caja",17,19),shift("gm","Caja - GM"),{...shift("history"),supersededAt:at(15)},{...shift("tomorrow"),date:"2026-10-01"}];
  input.auxiliaryShifts=[shift("office","Office")];
  expect(scheduledHeadcounts(input,[15,16,17,18,19,22])).toEqual([0,1,2,2,1,0]);
 });
 it("keeps partial work, subtracts complete and overlapping removals, and ignores cancelled removals",()=>{
  const input=day();
  const removal={id:"remove",kind:"remove" as const,employeeId:"evening",partnerEmployeeId:null,stationId:"green1",fromStationId:null,startAt:at(17,15),endAt:at(19),managerId:"synthetic",managerName:"Example",cancelledAt:null,endReason:null};
  input.overlays=[removal];
  expect(scheduledHeadcounts(input,[17,18,19],new Date(at(16)))).toEqual([1,0,1]);
  input.overlays.push({...removal,id:"earlier",startAt:at(17),endAt:at(17,30)});
  expect(scheduledHeadcounts(input,[17,18,19],new Date(at(16)))).toEqual([0,0,1]);
  input.overlays=input.overlays.map(row=>({...row,cancelledAt:at(16),endReason:"cancel"}));
  expect(scheduledHeadcounts(input,[17,18,19],new Date(at(16)))).toEqual([1,1,1]);
 });
});
describe("evening contiguous block regression",()=>{
 function render(input:DayBoardDto){const html=renderToStaticMarkup(createElement(SchedulePanel,{day:input,date,locale:"es",t:messagesFor("es"),now:new Date(at(16))}));const host=document.createElement("div");host.innerHTML=html;return host;}
 it("isolates the marked hour and joins the later four-hour run without hiding BREAK",()=>{
  const host=render(day());
  expect(host.querySelector('[data-testid="schedule-block-green1-18"]')?.getAttribute("colspan")).toBe("4");
  expect(host.querySelector('[data-testid="schedule-block-green1-17"]')?.getAttribute("colspan")).toBeNull();
  expect(host.querySelector('[data-testid="schedule-block-green1-17"]')?.textContent).toContain("BREAK");
 });
 it("preserves real gaps, seat changes and separate shifts",()=>{
  const input=day();const first=input.shifts[0]!;
  first.assignments=first.assignments.filter(a=>a.hourStart!==at(19));
  first.assignments.find(a=>a.hourStart===at(21))!.seatNumber=2;
  input.shifts.push({...shift("second","Caja",20,22),employee:first.employee,assignments:[]});
  const host=render(input);
  for(const h of [18,20,21]) expect(host.querySelector(`[data-testid="schedule-block-green1-${h}"]`)?.getAttribute("colspan")).toBe("1");
  expect(host.querySelector('[data-testid="schedule-block-green1-19"]')).toBeNull();
  expect(host.querySelectorAll('[data-testid^="schedule-row-"]')).toHaveLength(2);
 });
 it("does not bridge a missing hour in a filtered grid",()=>{
  expect(buildBlocksForHours(new Map([[18,"green1"],[20,"green1"]]),[18,20],new Map())).toMatchObject([{startHour:18,span:1},{startHour:20,span:1}]);
 });
});
const roots:Root[]=[];
afterEach(async()=>{await act(async()=>{for(const root of roots.splice(0))root.unmount();});vi.useRealTimers();document.body.innerHTML="";});
describe("auxiliary inactivity and focus",()=>{
 async function mount(locale:"es"|"en"="es"){
  vi.useFakeTimers();const host=document.createElement("div");document.body.appendChild(host);const root=createRoot(host);roots.push(root);
  await act(async()=>root.render(createElement(AuxiliaryPanel,{shifts:[shift("backup","GM")],locale})));
  return host;
 }
 it.each(["es","en"] as const)("%s closes after 20 seconds and reopens with its count",async locale=>{
  const host=await mount(locale);const button=host.querySelector("button")!;
  expect(button.textContent).toContain(locale==="es"?"REFUERZOS · 1":"BACKUP · 1");
  await act(async()=>vi.advanceTimersByTime(19_999));expect(button.getAttribute("aria-expanded")).toBe("true");
  await act(async()=>vi.advanceTimersByTime(251));expect(button.getAttribute("aria-expanded")).toBe("false");
  await act(async()=>button.click());expect(host.querySelector('[data-testid="auxiliary-rows"]')).not.toBeNull();
 });
 it("defers while focused or holding a pointer, then starts a fresh idle period",async()=>{
  const host=await mount();const button=host.querySelector("button")!;
  await act(async()=>button.focus());await act(async()=>vi.advanceTimersByTime(25_000));expect(button.getAttribute("aria-expanded")).toBe("true");
  await act(async()=>button.blur());await act(async()=>vi.advanceTimersByTime(19_000));
  await act(async()=>host.querySelector("section")!.dispatchEvent(new Event("pointerdown",{bubbles:true})));
  await act(async()=>vi.advanceTimersByTime(25_000));expect(button.getAttribute("aria-expanded")).toBe("true");
  await act(async()=>window.dispatchEvent(new Event("pointerup")));await act(async()=>vi.advanceTimersByTime(20_250));expect(button.getAttribute("aria-expanded")).toBe("false");
 });
});
