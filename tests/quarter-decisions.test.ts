import { assessStarGate } from "@/lib/slices/break-gate";
import { describe,it,expect } from "vitest";
import { buildDaySlices,type DaySliceInput } from "@/lib/slices/day-slices";
import { chicagoHourStart } from "@/lib/hour-grid";
const date="2038-10-12",start=+chicagoHourStart(date,13);
const at=(minutes:number)=>new Date(start+minutes*60000);
function fixture():DaySliceInput {
  return {date,board:"caja",now:at(10),stations:[{id:"purple1"},{id:"green1"}],starStationIds:["purple1"],overlays:[],
    shifts:[{id:"a",employeeId:"a",board:"caja",startAt:at(-60),endAt:at(60),superseded:false,boardRemoved:false},
      {id:"b",employeeId:"b",board:"cocina",startAt:at(-60),endAt:at(60),superseded:false,boardRemoved:false},
      {id:"c",employeeId:"c",board:"other",startAt:at(-60),endAt:at(60),superseded:false,boardRemoved:false}],
    paints:[{shiftId:"a",employeeId:"a",stationId:"purple1",hourStart:at(-60),intervalEnd:at(60)},
      {shiftId:"b",employeeId:"b",stationId:"pdf_tq1r",hourStart:at(-60),intervalEnd:at(60)}],
    breaks:[{employeeId:"a",shiftId:"a",board:"caja",startAt:at(0),endAt:at(30),status:"booked",coverEmployeeId:"b",coverShiftId:"b",shuffleShiftId:null}]};
}
const slice=(input:DaySliceInput,minute:number)=>buildDaySlices(input).slices.find(s=>+s.start===+at(minute))!;
describe("canonical decision intervals",()=>{
  it("joins contiguous fragments only when the same recorded source and station cover the full quarter",()=>{
    const input=fixture();input.breaks=[];input.paints=[{shiftId:"a",employeeId:"a",stationId:"purple1",hourStart:at(0),intervalEnd:at(5)},
      {shiftId:"a",employeeId:"a",stationId:"purple1",hourStart:at(5),intervalEnd:at(15)}];
    expect(slice(input,0).seats).toEqual([{stationId:"purple1",employeeId:"a",source:"paint"}]);
    input.paints=[input.paints[0],{...input.paints[1],stationId:"green1"}];expect(slice(input,0).seats).toHaveLength(0);
    input.paints=[input.paints[0],{...input.paints[1],stationId:"purple1",shiftId:"different-source"}];expect(slice(input,0).seats).toHaveLength(0);
  });
  it("applies the incoming cover and origin absence with half-open return boundaries",()=>{
    const input=fixture();const origin={...input,board:"cocina" as const,starStationIds:[]};
    expect(slice(input,-15).seats.find(s=>s.stationId==="purple1")?.employeeId).toBe("a");
    expect(slice(input,0).seats.find(s=>s.stationId==="purple1")?.employeeId).toBe("b");
    expect(slice(origin,0).seats.some(s=>s.employeeId==="b")).toBe(false);
    expect(slice(origin,0).people.find(p=>p.employeeId==="b")?.counts).toBe(false);
    expect(slice(input,30).seats.find(s=>s.stationId==="purple1")?.employeeId).toBe("a");
    expect(slice(origin,30).seats.find(s=>s.stationId==="pdf_tq1r")?.employeeId).toBe("b");
  });
  it("another shift for the same cover never substitutes for the persisted ID",()=>{
    const input=fixture();input.breaks[0].coverShiftId="old-shift";
    expect(slice(input,0).seats.some(s=>s.source==="cover")).toBe(false);
    expect(slice({...input,board:"cocina"},0).seats.some(s=>s.employeeId==="b")).toBe(true);
  });
  it("both Shuffle legs are atomic; an unavailable partner suppresses the entire move",()=>{
    const input=fixture();input.shifts[1].board="caja";input.paints[1].stationId="green1";
    input.breaks=[{...input.breaks[0],shuffleEmployeeId:"c",shuffleShiftId:"c"}];
    expect(slice(input,0).seats).toEqual(expect.arrayContaining([{stationId:"purple1",employeeId:"b",source:"cover"},{stationId:"green1",employeeId:"c",source:"cover"}]));
    input.breaks[0].shuffleShiftId="missing";
    expect(slice(input,0).seats.some(s=>s.source==="cover")).toBe(false);
    expect(slice(input,0).seats.find(s=>s.stationId==="green1")?.employeeId).toBe("b");
  });
  it("a candidate preview binds the chosen source even when another shift for that person sorts first",()=>{
    const input=fixture();input.breaks=[];input.shifts=[{...input.shifts[1],id:"shadow"},...input.shifts];
    const result=assessStarGate({...input,employeeId:"a",requesterShiftId:"a",canonical:true,startAt:at(0),endAt:at(30),coverEmployeeId:"b",coverShiftId:"b"});
    expect(result).toMatchObject({status:"booked",coverShiftId:"b"});
    expect(assessStarGate({...input,employeeId:"a",requesterShiftId:"a",canonical:true,startAt:at(0),endAt:at(30),coverEmployeeId:"b",coverShiftId:"absent"})).toEqual({code:"BAD_COVER"});
  });
  it("partial factual presence cannot satisfy a full-quarter decision",()=>{
    const input=fixture();input.breaks=[];input.shifts[0].endAt=at(20);input.paints[0].intervalEnd=at(20);
    expect(slice(input,15).seats.some(s=>s.employeeId==="a")).toBe(false);
    expect(slice(input,0).seats.some(s=>s.employeeId==="a")).toBe(true);
  });
});
