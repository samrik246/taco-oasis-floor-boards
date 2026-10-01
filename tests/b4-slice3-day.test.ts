import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET } from "@/app/api/boards/[board]/days/[date]/route";
import { signManagerSession } from "@/lib/managers/session";
import { gerenteAuthority } from "@/lib/breaks/authority";
import { chicagoDateTime } from "@/lib/time";
import { paletteStationIds } from "@/lib/assignments/palette-order";
import { isDefaultMandatory } from "@/lib/mandatory";
import { buildScheduleGrid, comparePintarRows } from "@/lib/schedule/build-schedule";
import type { DayBoardDto } from "@/components/board/types";
const db=new PrismaClient(), date="2097-08-21", tag=`b4s3-${Date.now()}`;
let owner:string,manager:string,managerId:string,gm:string;
const employees:string[]=[],managers:string[]=[];
const roles=["Caja - GM","Caja - UP Manager","GM","UP Manager","Produccion","Picar Carne","Catering Manager","Catering DRIVER","Caja - Regular","Cocina Guia Abrir"];
async function read(board:"caja"|"cocina",token?:string){return GET(new Request("http://local/api/boards",{headers:token?{"x-manager-session":token}:{}}),{params:Promise.resolve({board,date})});}
describe("B4 auxiliary day projection and shared presentation order",()=>{
 beforeAll(async()=>{
  for(const [i,position] of roles.entries()){
   const person=await db.employee.create({data:{externalId:`${tag}-${i}`,firstName:"Example",lastName:String(i)}});employees.push(person.id);if(i===0)gm=person.id;
   await db.shift.create({data:{employeeId:person.id,date,board:position.includes("Caja")?"caja":position.includes("Cocina")?"cocina":"other",sourcePosition:position,startAt:chicagoDateTime(date,"4:00 pm"),endAt:chicagoDateTime(date,"10:00 pm")}});
  }
  for(const role of ["owner","manager"]){const row=await db.manager.create({data:{name:`${tag}-${role}`,role,codeHash:"synthetic-unused",employeeId:gm}});managers.push(row.id);if(role==="owner")owner=signManagerSession(row);else{manager=signManagerSession(row);managerId=row.id;}}
 });
 afterAll(async()=>{await db.mandatoryMark.deleteMany({where:{managerId:{in:managers}}});await db.manager.deleteMany({where:{id:{in:managers}}});await db.shift.deleteMany({where:{employeeId:{in:employees}}});await db.employee.deleteMany({where:{id:{in:employees}}});await db.$disconnect();});
 it("shows the same six backup positions on both boards, without credentials or paint; stored routing stays intact",async()=>{
  const before=await db.shift.findMany({where:{employeeId:{in:employees}},orderBy:{id:"asc"}});
  const results:DayBoardDto[]=[];
  for(const board of ["caja","cocina"] as const){const response=await read(board,owner);expect(response.status).toBe(200);const body:DayBoardDto=await response.json();results.push(body);
   expect(body.auxiliaryShifts?.map(row=>row.sourcePosition).sort()).toEqual(roles.slice(0,6).sort());
   expect(body.shifts.map(row=>row.sourcePosition)).toEqual([board==="caja"?"Caja - Regular":"Cocina Guia Abrir"]);
   for(const row of body.auxiliaryShifts!){expect(Object.keys(row).sort()).toEqual(["date","employee","endAt","id","sourcePosition","startAt"]);expect(Object.keys(row.employee).sort()).toEqual(["firstName","id","lastName"]);}
  }
  expect(results[0]!.auxiliaryShifts).toEqual(results[1]!.auxiliaryShifts);
  expect(await db.shift.findMany({where:{employeeId:{in:employees}},orderBy:{id:"asc"}})).toEqual(before);
  expect(await gerenteAuthority(managerId,chicagoDateTime(date,"9:00 am"),db)).toBeNull();
 });
 it("keeps auxiliary planned dates behind the existing server owner boundary",async()=>{
  for(const board of ["caja","cocina"] as const){expect((await read(board)).status).toBe(401);expect((await read(board,manager)).status).toBe(403);}
 });
 it.each(["caja","cocina"] as const)("%s default and one-day mandatory ranks are shared by palette, schedule, paint and reloading",async board=>{
  const extra=board==="caja"?"blue":"pdf_pstl";
  await db.mandatoryMark.create({data:{board,date,stationId:extra,managerId:managers[0]!}});
  const body:DayBoardDto=await (await read(board,owner)).json();
  const ids=body.stations.map(station=>station.id), defaults=ids.filter(isDefaultMandatory);
  expect(ids.slice(0,defaults.length)).toEqual(defaults);expect(ids[defaults.length]).toBe(extra);
  expect(paletteStationIds({stations:body.stations,stationUse:body.stationUse,extraStationIds:body.mandatory?.extraStationIds})).toEqual(ids);
  expect((await (await read(board,owner)).json()).stations).toEqual(body.stations);
  const shifts=body.stations.map((station,i)=>({...body.shifts[0]!,id:`synthetic-${i}`,employee:{...body.shifts[0]!.employee,id:`person-${i}`},assignments:[{id:`a${i}`,stationId:station.id,hourStart:chicagoDateTime(date,"4:00 pm").toISOString(),hourEnd:chicagoDateTime(date,"5:00 pm").toISOString()}]}));
  const grid=buildScheduleGrid({date,shifts,stations:body.stations,mode:"all-day",sort:"position",unassignedGroupLabel:"None"});
  expect(grid.sections.map(section=>section.stationId)).toEqual(ids);
  const order=new Map(body.stations.map(station=>[station.id,station.sortOrder]));
  const rows=shifts.map(shift=>({name:shift.employee.firstName,employeeId:shift.employee.id,startAt:shift.startAt,shiftId:shift.id,stationId:shift.assignments[0]!.stationId}));
  expect(rows.reverse().sort((a,b)=>comparePintarRows(a,b,"position",order)).map(row=>row.stationId)).toEqual(ids);
 });
});
