import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { PAINT_FAMILIES, familyForStation } from "@/lib/assignments/paint-families";
import { isValidMoveReason } from "@/lib/position-moves";
import { canonical, digest, CAPABILITY_SHA256, QuarterRefused, quarterState, worldRevision, type QuarterDb } from "./schema";
import { paintCommandSchema, quarterInstant, type PaintCommand } from "./protocol";
import { HOUR_MS, QUARTER_MS, hourKey, resolvePaintWorld, sourceSnapshot, overlaps, type PaintHour, type PaintWorld } from "./world";
import { peerHours, projectSeatNumbers, validatePaintWorld, validateObligations } from "./validation";

export type CommandActor = { id:string; name:string };
export type PaintReceipt = { ok:true; requestId:string; requestSha256:string; databaseEpoch:string; committedRevision:string;
  draftSubmission?:PaintCommand["draftSubmission"]; hours:{ shiftId:string; hourStart:string; revision:string }[]; refreshRequired:true };
export async function quarterWrite<T>(client:PrismaClient, run:(tx:QuarterDb)=>Promise<T>):Promise<T> {
  for (let attempt=0; attempt<3; attempt++) {
    try {
      return await client.$transaction(async tx => {
        await tx.staffBreakLock.upsert({ where:{id:1},create:{id:1},update:{updatedAt:new Date()} });
        return run(tx);
      },{timeout:30_000,maxWait:10_000});
    } catch (error) {
      const busy = error instanceof Error && /SQLITE_BUSY|database is locked|P2034/.test(error.message);
      if (!busy) throw error;
      if (attempt===2) throw new QuarterRefused("LOCK_CONFLICT",503);
    }
  }
  throw new QuarterRefused("LOCK_CONFLICT",503);
}
export async function receiptFor(db:QuarterDb, actorId:string, requestId:string) {
  if (!await quarterState(db)) return null;
  const rows = await db.$queryRawUnsafe<{requestSha256:string;databaseEpoch:string;responseJson:string}[]>(
    "SELECT requestSha256,databaseEpoch,responseJson FROM PaintCommandReceipt WHERE actorId=? AND requestId=?",actorId,requestId);
  return rows[0] ?? null;
}
export async function persistHour(db:QuarterDb, h:PaintHour, now:Date):Promise<void> {
  if (!h.id) {
    h.id=randomUUID(); h.revision="1";
    await db.$executeRawUnsafe(`INSERT INTO PaintHour (id,shiftId,employeeId,date,board,hourStartMs,revision,sourceJson,sourceSha256,legacyJson,legacySha256,adoptedAtMs,updatedAtMs) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?)`,
      h.id,h.shiftId,h.employeeId,h.date,h.board,h.hourStartMs,h.sourceJson,h.sourceSha256,h.legacyJson,h.legacySha256,+now,+now);
  } else {
    const prior=h.revision!;
    const changed=await db.$executeRawUnsafe("UPDATE PaintHour SET revision=revision+1,sourceJson=?,sourceSha256=?,updatedAtMs=? WHERE id=? AND revision=CAST(? AS INTEGER)",h.sourceJson,h.sourceSha256,+now,h.id,prior);
    if (changed!==1) throw new QuarterRefused("REVISION_CONFLICT");
    h.revision=(BigInt(prior)+BigInt(1)).toString();
  }
  await replaceHourSegments(db,h);
}
export async function replaceHourSegments(db:QuarterDb,h:PaintHour):Promise<void> {
  if(!h.id)throw new QuarterRefused("QUARTER_HOUR_ID_REQUIRED");
  await db.$executeRawUnsafe("DELETE FROM PaintSegment WHERE paintHourId=?",h.id);
  for (const s of h.segments) {
    s.id=randomUUID(); delete s.assignmentId;
    await db.$executeRawUnsafe("INSERT INTO PaintSegment (id,paintHourId,quarterStartMs,startMs,endMs,state,stationId,seatNumber) VALUES (?,?,?,?,?,?,?,?)",
      s.id,h.id,s.quarterStartMs,s.startMs,s.endMs,s.state,s.stationId,s.seatNumber);
  }
}
export async function recordMutation(db:QuarterDb, actorId:string,requestId:string,before:PaintHour,after:PaintHour,now:Date,
  detail:{operation:string;reason?:string;moveNote?:string|null;startMs?:number;endMs?:number}) {
  await db.$executeRawUnsafe(`INSERT INTO PaintMutation VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(),actorId,requestId,after.date,after.board,after.shiftId,
    detail.startMs??after.hourStartMs,detail.endMs??after.hourStartMs+HOUR_MS,detail.operation,detail.reason??null,detail.moveNote??null,
    canonical(before.segments),canonical(after.segments),+now);
}

export function checkExpectations(command:Pick<PaintCommand,"expected"|"sources"|"hours">, world:PaintWorld) {
  if (world.state?.phase!=="active") throw new QuarterRefused("QUARTER_NOT_ACTIVE");
  if (world.state.databaseEpoch!==command.expected.databaseEpoch) throw new QuarterRefused("DATABASE_EPOCH_CHANGED");
  if (world.revision!==command.expected.worldRevision) throw new QuarterRefused("REVISION_CONFLICT");
  const seen=new Set<string>();
  for (const s of command.sources) {
    if (seen.has(s.shiftId)) throw new QuarterRefused("DUPLICATE_SOURCE",422);
    seen.add(s.shiftId);
    const actual=world.sources.find(a=>a.id===s.shiftId);
    const expected={shiftId:s.shiftId,employeeId:s.employeeId,date:s.date,board:s.board,sourcePosition:s.sourcePosition,
      startAtMs:+new Date(s.startAt),endAtMs:+new Date(s.endAt),supersededAtMs:s.supersededAt===null?null:+new Date(s.supersededAt),boardRemoved:s.boardRemoved};
    if (!actual || canonical(sourceSnapshot(actual))!==canonical(expected) || actual.supersededAt || actual.boardRemoved) throw new QuarterRefused("SOURCE_CHANGED");
  }
  const keys=new Set<string>();
  for (const e of command.hours) {
    const key=hourKey(e.shiftId,+new Date(e.hourStart));
    if (keys.has(key)) throw new QuarterRefused("DUPLICATE_HOUR",422);
    keys.add(key);
    const h=world.hours.find(h=>hourKey(h.shiftId,h.hourStartMs)===key);
    if (!seen.has(e.shiftId) || !h || h.revision!==e.revision || (e.revision===null && h.legacySha256!==e.legacySha256)) throw new QuarterRefused("HOUR_CHANGED");
  }
}

export async function applyPaintCommand(db:QuarterDb,command:PaintCommand,actor:CommandActor,now:Date, identity:unknown=command):Promise<PaintReceipt> {
  const requestSha256=digest(identity);
  const prior=await receiptFor(db,actor.id,command.requestId);
  if (prior) {
    if (prior.requestSha256!==requestSha256 || prior.databaseEpoch!==command.expected.databaseEpoch) throw new QuarterRefused("REQUEST_ID_REUSE");
    return JSON.parse(prior.responseJson) as PaintReceipt;
  }
  if (command.capabilitySha256!==CAPABILITY_SHA256) throw new QuarterRefused("CAPABILITY_CHANGED");
  const before=await resolvePaintWorld(db,command.date);
  checkExpectations(command,before);
  const after=structuredClone(before);
  projectSeatNumbers(after);
  const preEdit=structuredClone(after);
  const keys=new Set<string>();
  const windows=command.intents.map(intent=>{
    const startMs=quarterInstant(command.date,intent.quarter);
    const hourStartMs=startMs-(Number(intent.quarter.slice(3))*60_000);
    if (intent.granularity==="hour" && startMs!==hourStartMs) throw new QuarterRefused("INVALID_HOUR",422);
    const endMs=startMs+(intent.granularity==="hour"?HOUR_MS:QUARTER_MS);
    const key=hourKey(intent.shiftId,hourStartMs);
    const h=after.hours.find(h=>hourKey(h.shiftId,h.hourStartMs)===key);
    if (!h || h.board!==command.board || !command.hours.some(e=>e.shiftId===intent.shiftId && +new Date(e.hourStart)===hourStartMs)) throw new QuarterRefused("MISSING_EXPECTATION",422);
    for (let q=startMs;q<endMs;q+=QUARTER_MS) {
      const cell=hourKey(intent.shiftId,q);
      if (keys.has(cell)) throw new QuarterRefused("DUPLICATE_INTENT",422);
      keys.add(cell);
    }
    const selected=h.segments.filter(s=>s.state!=="off" && overlaps(s,{startMs,endMs}));
    if (!selected.length) throw new QuarterRefused("OUT_OF_SHIFT",422);
    if (intent.granularity==="hour" && new Set(selected.map(s=>`${s.state}|${s.stationId}`)).size>1) throw new QuarterRefused("HOUR_NEEDS_QUARTER");
    if (+now>=hourStartMs && selected.some(s=>s.state==="assigned" && (intent.action!=="station" || intent.stationId!==s.stationId)) && !isValidMoveReason(intent.reason??"")) throw new QuarterRefused("REASON_REQUIRED",422);
    return {intent,h,key,startMs,endMs,selected};
  });
  const obligations=await db.staffBreak.findMany({where:{date:command.date,status:"booked"}});
  const overlays=await db.boardOverlay.findMany({where:{date:command.date,cancelledAt:null}});
  for (const w of windows.filter(w=>w.intent.granularity==="hour")) {
    if (obligations.some(b=>[b.employeeId,b.coverEmployeeId,b.shuffleEmployeeId].includes(w.h.employeeId) && +b.startAt<w.endMs && +b.endAt>w.startMs) ||
      overlays.some(o=>[o.employeeId,o.partnerEmployeeId].includes(w.h.employeeId) && +o.startAt<w.endMs && +o.endAt>w.startMs)) throw new QuarterRefused("HOUR_NEEDS_QUARTER");
  }
  const touched=new Set(windows.map(w=>w.key));
  const targets=windows.flatMap(w=>(w.intent.action==="station"?[w.intent.stationId]:w.intent.action==="family"?[...PAINT_FAMILIES[w.intent.family]]:[]).map(stationId=>({hourStartMs:w.h.hourStartMs,stationId})));
  peerHours(preEdit,touched,targets);
  // Stage departures together before explicit arrivals, then resolve family choices.
  for (const w of windows) for (const s of w.selected) { s.state="erased";s.stationId=null;s.seatNumber=null; }
  for (const w of windows.filter(w=>w.intent.action==="station")) {
    if (w.intent.action!=="station") continue;
    for (const s of w.selected) {s.state="assigned";s.stationId=w.intent.stationId;}
  }
  await validatePaintWorld(db,after,touched);
  for (const w of windows.filter(w=>w.intent.action==="family").sort((a,b)=>a.startMs-b.startMs || a.h.shiftId.localeCompare(b.h.shiftId))) {
    if (w.intent.action!=="family") continue;
    const ids=[...PAINT_FAMILIES[w.intent.family]] as string[];
    const adjacent=after.hours.filter(h=>h.shiftId===w.h.shiftId).flatMap(h=>h.segments).find(s=>s.endMs===w.startMs && s.stationId && ids.includes(s.stationId));
    const original=preEdit.hours.find(h=>hourKey(h.shiftId,h.hourStartMs)===w.key)!.segments.find(s=>s.startMs===w.startMs)?.stationId;
    const order=[...new Set([adjacent?.stationId,original,...ids].filter((id):id is string=>Boolean(id && ids.includes(id))))];
    let placed=false;
    for (const stationId of order) {
      for (const s of w.selected) {s.state="assigned";s.stationId=stationId;}
      try { await validatePaintWorld(db,after,touched);placed=true;break; }
      catch(error) { if (!(error instanceof QuarterRefused) || !["STATION_FULL","FORBIDDEN_ABILITY"].includes(error.code)) throw error; }
    }
    if (!placed) throw new QuarterRefused("FAMILY_UNAVAILABLE",409);
  }
  // Carry original numbers within a family. All peer legacy numbers were projected before editing.
  for (const w of windows) for (const s of w.selected) {
    const old=preEdit.hours.find(h=>hourKey(h.shiftId,h.hourStartMs)===w.key)!.segments.find(p=>p.startMs===s.startMs);
    if (old?.stationId && s.stationId && familyForStation(old.stationId)===familyForStation(s.stationId)) s.seatNumber=old.seatNumber;
  }
  projectSeatNumbers(after);
  await validatePaintWorld(db,after,touched);
  await validateObligations(db,before,after,now);
  const changed=after.hours.filter(h=>touched.has(hourKey(h.shiftId,h.hourStartMs)));
  for (const h of changed) {
    const original=before.hours.find(old=>hourKey(old.shiftId,old.hourStartMs)===hourKey(h.shiftId,h.hourStartMs))!;
    await persistHour(db,h,now);
    const edits=windows.filter(w=>w.h===h);
    if (!edits.length) await recordMutation(db,actor.id,command.requestId,original,h,now,{operation:"adopt-peer"});
    for (const w of edits) await recordMutation(db,actor.id,command.requestId,original,h,now,{operation:w.intent.action,reason:w.intent.reason,moveNote:w.intent.moveNote,startMs:w.startMs,endMs:w.endMs});
  }
  // Read back the entire canonical world before allowing the transaction to commit.
  await resolvePaintWorld(db,command.date);
  const committedRevision=await worldRevision(db);
  const response:PaintReceipt={ok:true,requestId:command.requestId,requestSha256,databaseEpoch:command.expected.databaseEpoch,committedRevision,
    ...(command.draftSubmission?{draftSubmission:command.draftSubmission}:{}),hours:changed.map(h=>({shiftId:h.shiftId,hourStart:new Date(h.hourStartMs).toISOString(),revision:h.revision!})),refreshRequired:true};
  await db.$executeRawUnsafe("INSERT INTO PaintCommandReceipt VALUES (?,?,?,?,?,?,?,?)",actor.id,command.requestId,requestSha256,command.expected.databaseEpoch,command.expected.worldRevision,committedRevision,canonical(response),+now);
  await db.boardChangeLog.create({data:{managerId:actor.id,managerName:actor.name,date:command.date,route:"PUT /api/v2/assignments/paint",summary:`${command.date} board=${command.board} command=${command.requestId} intervals=${windows.map(w=>`${w.startMs}-${w.endMs}`).join(",")}`}});
  return response;
}
export async function paintV2(input:unknown,actor:CommandActor,now=new Date(),client=prisma):Promise<PaintReceipt> {
  if (Buffer.byteLength(canonical(input),"utf8")>2*1024*1024) throw new QuarterRefused("REQUEST_TOO_LARGE",413);
  const command=paintCommandSchema.parse(input);
  return quarterWrite(client,db=>applyPaintCommand(db,command,actor,now));
}
