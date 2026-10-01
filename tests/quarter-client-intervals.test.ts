import {describe,expect,it} from "vitest";
import {chicagoHourStart} from "@/lib/hour-grid";
import {buildScheduleGrid} from "@/lib/schedule/build-schedule";
import {publicDaySchema,boardFromV2,saveBoardV2,readBoardV2,BOARD_CACHE_V2} from "@/lib/quarter/client/day";
import {savedHourSegments,savedStationOccupantsNow} from "@/components/board/cover-display";
import {slicesForDay} from "@/components/board/day-slice-input";
import {convertV1} from "@/lib/quarter/client/v1-conversion";
import {findBoardViolations} from "@/lib/violations";
import {proposeHours} from "@/lib/quarter/client/edit";
import {uniformHour} from "@/lib/quarter/client/intervals";
const date="2038-10-12",start=+chicagoHourStart(date,11),iso=(minutes:number)=>new Date(start+minutes*60000).toISOString();
function fixture(){return publicDaySchema.parse({schemaVersion:2,databaseEpoch:"epoch",worldRevision:"10",phase:"active",capabilitySha256:"a".repeat(64),board:"caja",date,
 employees:[{id:"person",firstName:"Synthetic",lastName:"Person",email:"NEVER_CACHE",abilities:[{stationId:"purple1",level:"forbidden"}]}],
 stations:[{id:"purple1",label:"P1",color:"purple",maxConcurrent:1,sortOrder:1,shortCode:"P1"},{id:"green1",label:"G1",color:"green",maxConcurrent:1,sortOrder:2,shortCode:"G1"}],
 sources:[{shiftId:"source",employeeId:"person",date,board:"caja",sourcePosition:"Caja",startAt:iso(0),endAt:iso(20),supersededAt:null,boardRemoved:false}],
 hours:[{shiftId:"source",hourStart:iso(0),revision:"2",intervals:[
  {startAt:iso(0),endAt:iso(15),state:"assigned",stationId:"purple1",seatNumber:1,provenance:{kind:"v2",paintHourId:"hour",segmentId:"first"}},
  {startAt:iso(15),endAt:iso(20),state:"assigned",stationId:"green1",seatNumber:2,provenance:{kind:"v2",paintHourId:"hour",segmentId:"tail"}},
  {startAt:iso(20),endAt:iso(60),state:"off",stationId:null,seatNumber:null,provenance:{kind:"v2",paintHourId:"hour",segmentId:"off"}},
 ]}],coverDisplay:{version:1,tracks:[],unavailable:[],hidden:"NEVER_CACHE"},extra:"NEVER_CACHE"});}
function storage():Storage {const data=new Map<string,string>();return {get length(){return data.size;},getItem:k=>data.get(k)??null,setItem:(k,v)=>{data.set(k,v);},removeItem:k=>{data.delete(k);},key:i=>[...data.keys()][i]??null,clear:()=>data.clear()};}
describe("explicit interval client truth",()=>{
 it("preserves mixed/tail geometry and half-open wall occupants without Assignment rows",()=>{
  const day=boardFromV2(fixture());expect(day.shifts[0].assignments).toEqual([]);
  expect(uniformHour(day.shifts[0],date,11).kind).toBe("mixed");
  expect(savedHourSegments(day,"source",11)?.map(s=>[s.startAt,s.endAt])).toEqual([[iso(0),iso(15)],[iso(15),iso(20)]]);
  expect(savedStationOccupantsNow(day,"purple1",new Date(iso(15)))).toEqual([]);
  expect(savedStationOccupantsNow(day,"green1",new Date(iso(15)))?.map(r=>r.employeeId)).toEqual(["person"]);
  expect(savedStationOccupantsNow(day,"green1",new Date(iso(20)))).toEqual([]);
  const grid=buildScheduleGrid({date,shifts:day.shifts,stations:day.stations,mode:"all-day",unassignedGroupLabel:"Open"});
  expect(grid.sections[0].rows[0].mixedHours).toEqual([11]);expect(grid.sections[0].rows[0].blocks.map(b=>b.span)).toEqual([0.25,5/60]);
  expect(grid.headcount[4]).toBe(1);expect(grid.manHours[4]).toBeCloseTo(1/3);
  expect(slicesForDay(day,new Date(iso(0))).slices[16].seats.some(s=>s.stationId==="purple1")).toBe(true);
  expect(slicesForDay(day,new Date(iso(0))).slices[17].seats.some(s=>s.stationId==="green1")).toBe(false);
 });
 it("allowlists on both cache writes and reads, never mutates unsupported or other-day bytes",()=>{
  const store=storage(),now=new Date(iso(0));store.setItem("taco-oasis-last-board-v1","old");store.setItem("taco-oasis-paint-draft-v1:m:caja:2038-10-12","private");
  expect(saveBoardV2(fixture(),now,store)).toBe(true);expect(store.getItem(BOARD_CACHE_V2)).not.toContain("NEVER_CACHE");
  expect(store.getItem("taco-oasis-last-board-v1")).toBeNull();expect(store.getItem("taco-oasis-paint-draft-v1:m:caja:2038-10-12")).toBe("private");
  const raw=JSON.parse(store.getItem(BOARD_CACHE_V2)!);raw.day.employees[0].abilities="NEVER_CACHE";raw.day.coverDisplay.hidden="NEVER_CACHE";store.setItem(BOARD_CACHE_V2,JSON.stringify(raw));
  expect(JSON.stringify(readBoardV2("caja",now,store))).not.toContain("NEVER_CACHE");expect(readBoardV2("cocina",now,store).status).toBe("unavailable");
  store.setItem(BOARD_CACHE_V2,'{"version":3,"keep":"original"}');expect(readBoardV2("caja",now,store).status).toBe("unsupported");expect(store.getItem(BOARD_CACHE_V2)).toContain("original");
 });
 it("retains malformed and stale V1 originals with unknown first-dirty provenance",()=>{
  const raw="{unfinished", converted=convertV1({managerId:"m",board:"caja",date},raw,fixture());
  expect(converted.archive.original).toBe(raw);expect(converted.proposal.envelope.firstDirtyAt).toBeNull();expect(converted.proposal.envelope.reviewReasons).toContain("V1_FORMAT_REQUIRES_REVIEW");
  const day=fixture(),source=day.sources[0],v1=JSON.stringify({version:1,updatedAt:iso(0),edits:[{shiftId:"source",hour:11,stationId:"green1",expected:null,expectedShift:{startAt:source.startAt,endAt:source.endAt,employeeId:source.employeeId,sourcePosition:source.sourcePosition}}]});
  expect(convertV1({managerId:"m",board:"caja",date},v1,day).archive.staleReason).toContain("V1_HOUR_ADOPTED");
 });
 it("sweeps actual overlap bounds and shows public blocked facts without private levels",()=>{
  const day=fixture();day.hours[0].intervals[0].abilityBlocked=true;
  const other=structuredClone(day.sources[0]);other.shiftId="second";other.employeeId="second-person";other.startAt=iso(15);other.endAt=iso(20);day.sources.push(other);day.employees.push({id:"second-person",firstName:"Other",lastName:"Synthetic"});
  day.hours.push({shiftId:"second",hourStart:iso(0),revision:"1",intervals:[
    {startAt:iso(0),endAt:iso(15),state:"off",stationId:null,seatNumber:null,provenance:{kind:"v2",paintHourId:"other",segmentId:"off1"}},
    {startAt:iso(15),endAt:iso(20),state:"assigned",stationId:"purple1",seatNumber:1,provenance:{kind:"v2",paintHourId:"other",segmentId:"on"}},
    {startAt:iso(20),endAt:iso(60),state:"off",stationId:null,seatNumber:null,provenance:{kind:"v2",paintHourId:"other",segmentId:"off2"}},
  ]});
  const clean=findBoardViolations(boardFromV2(day));expect(clean.some(v=>v.code==="STATION_FULL")).toBe(false);expect(clean.find(v=>v.code==="FORBIDDEN_ABILITY")?.interval).toEqual({shiftId:"source",startAt:iso(0),endAt:iso(15)});
  day.hours[0].intervals[1].stationId="purple1";
  const crowded=findBoardViolations(boardFromV2(day)).filter(v=>v.code==="STATION_FULL");expect(crowded).toHaveLength(2);
  expect(crowded.every(v=>v.assignmentId===null&&v.interval?.startAt===iso(15)&&v.interval.endAt===iso(20))).toBe(true);
 });
 it("refuses mixed-hour bulk controls and detects original legacy assignment bounds",()=>{
  const day=fixture(),scope={managerId:"m",board:"caja" as const,date},snapshot={head:null,generations:[],submissions:[],archives:[],originals:[],warnings:[]};
  expect(()=>proposeHours(scope,snapshot,day,[{shiftId:"source",hour:11,action:{action:"erase"}}])).toThrow("HOUR_NEEDS_QUARTER");
  day.sources[0].endAt=iso(60);day.hours[0]={shiftId:"source",hourStart:iso(0),revision:null,legacySha256:"b".repeat(64),intervals:[{startAt:iso(0),endAt:iso(60),state:"assigned",stationId:"purple1",seatNumber:1,provenance:{kind:"legacy",assignmentId:"original",startAt:iso(0),endAt:iso(60)}}]};
  const source=day.sources[0],raw=JSON.stringify({version:1,updatedAt:iso(0),edits:[{shiftId:source.shiftId,hour:11,expected:{id:"original",stationId:"purple1"},stationId:"green1",expectedShift:{startAt:source.startAt,endAt:source.endAt,employeeId:source.employeeId,sourcePosition:source.sourcePosition}}]});
  expect(convertV1(scope,raw,day).archive.result).toBe("converted");
  const converted=convertV1(scope,raw,day).proposal;
  const retained={...snapshot,head:{...scope,localRevision:"1",generationId:converted.generationId,state:"outstanding" as const,pendingRequestId:null},generations:[converted]};
  const original=JSON.stringify(retained);
  expect(()=>proposeHours(scope,retained,day,[{shiftId:"source",hour:11,action:{action:"erase"}}])).toThrow("QUARTER_DRAFT_REVIEW_ONLY");
  expect(JSON.stringify(retained)).toBe(original);

  const provenance=day.hours[0].intervals[0].provenance;if(provenance.kind!=="legacy")throw new Error("fixture");provenance.endAt=iso(75);
  const refused=convertV1(scope,raw,day);expect(refused.archive.original).toBe(raw);expect(refused.archive.staleReason).toContain("V1_ASSIGNMENT_CHANGED");
 });

});
