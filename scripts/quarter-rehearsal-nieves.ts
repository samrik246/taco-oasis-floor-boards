/** External synthetic driver. All application functions load from the named artifact,
 * including frozen R0; no helper is copied into or used to reseal that artifact. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const [appArg, mode, date, output, priorFile] = process.argv.slice(2);
const app = realpathSync(appArg), root = realpathSync(process.env.FLOOR_BOARDS_TEST_ROOT!);
assert(app.startsWith(root + path.sep)); assert(path.resolve(output).startsWith(root + path.sep));
assert(["prepared", "seed", "recovered", "returned"].includes(mode));
const load = createRequire(path.join(app, "package.json"));
const { prisma: db } = load(path.join(app, "src/lib/db.ts")) as typeof import("../src/lib/db");
const boundary = load(path.join(app, "src/lib/quarter/test-boundary.ts")) as typeof import("../src/lib/quarter/test-boundary");
const artifact = load(path.join(app, "src/lib/quarter/artifact.ts")) as typeof import("../src/lib/quarter/artifact");
const { withReleaseLease } = load(path.join(app, "src/lib/quarter/lease.ts")) as typeof import("../src/lib/quarter/lease");
const { importerIdentity } = load(path.join(app, "src/lib/quarter/importer-identity.ts")) as typeof import("../src/lib/quarter/importer-identity");
const { assertArtifactCompatibility } = load(path.join(app, "src/lib/quarter/compatibility.ts")) as typeof import("../src/lib/quarter/compatibility");
const { runFolderImport } = load(path.join(app, "src/lib/import/folder-import.ts")) as typeof import("../src/lib/import/folder-import");
const { resolvePaintWorld, assignedIntervals } = load(path.join(app, "src/lib/quarter/world.ts")) as typeof import("../src/lib/quarter/world");
const { canonical, CAPABILITY_SHA256 } = load(path.join(app, "src/lib/quarter/schema.ts")) as typeof import("../src/lib/quarter/schema");
const { paintV2 } = load(path.join(app, "src/lib/quarter/transaction.ts")) as typeof import("../src/lib/quarter/transaction");
const { chicagoHourStart } = load(path.join(app, "src/lib/hour-grid.ts")) as typeof import("../src/lib/hour-grid");
const manifest = artifact.verifiedArtifact();
const checks: string[] = [], operations: unknown[] = [];
const minute = 60000, base = +chicagoHourStart(date, 10);
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const check = (name: string, action: () => void) => { action(); checks.push(name); };
const world = (day = date) => db.$transaction(tx => resolvePaintWorld(tx, day));
const work = async (day = date) => (await assignedIntervals(await world(day))).map(s => ({ shiftId: s.shiftId, employeeId: s.employeeId, startMs: s.startMs, endMs: s.endMs, stationId: s.stationId, seatNumber: s.seatNumber })).sort((a,b) => canonical(a).localeCompare(canonical(b)));
const dayAfter = (offset: number) => new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0,10);
type Row = { id: string; start?: number; end?: number; role?: string };
const rows: Row[] = [{ id: "Alma", end: 180 }, { id: "Beto", end: 180 }, { id: "Celia", end: 180 }];
const prefix = `nieves-proof-${date}-`;
async function mapping(stationId: string | null) {
  await db.positionStationMap.upsert({ where: { position: "Caja - Nieves" }, create: { position: "Caja - Nieves", stationId }, update: { stationId } });
}
async function imported(label: string, input: Row[], day = date, expected = "imported") {
  const dir = path.join(path.dirname(output), `${mode}-${label}`); mkdirSync(dir);
  const time = (offset: number) => { const total = 600 + offset; const hour=Math.floor(total/60); return `${hour%12||12}:${String(total % 60).padStart(2,"0")} ${hour>=12?"pm":"am"}`; };
  const file = path.join(dir, "Schedule_for_nieves.csv");
  writeFileSync(file, "Schedule,Site,Position,First Name,Last Name,Employee ID,Email,Shift Start Date,Shift Start Time,Shift End Time,Hourly Rate,Status\n" + input.map(r => `Synthetic,Synthetic,${r.role ?? "Caja - Nieves"},${r.id},Synthetic,${prefix}${r.id},,${day},${time(r.start ?? 0)},${time(r.end ?? 60)},0,Published\n`).join(""));
  const identity = await importerIdentity("folder");
  let result;
  try { result = await withReleaseLease(async () => {
    identity.check(); await identity.state("running"); await assertArtifactCompatibility(db);
    return runFolderImport({ dir, mode: "apply" }, { now: new Date(`${day}T14:00:00Z`) });
  }); } finally { await identity.close(); }
  assert.equal(result.outcome, expected, `${label}: ${canonical(result)}`);
  if(expected==="refused")assert.equal(result.code,"DUPLICATE");
  const receipts = await db.$queryRawUnsafe<{ requestId: string; responseJson: string }[]>("SELECT requestId,responseJson FROM PaintCommandReceipt WHERE responseJson LIKE ? ORDER BY requestId", `%${day}%`);
  const observation = { label, day, input, sources: plain((await world(day)).sources), inputSha256: createHash("sha256").update(readFileSync(file)).digest("hex"), result, receipts, rows: await work(day) };
  operations.push(plain(observation)); return observation;
}
async function snapshot() {
  const w = await world();
  return plain({ sources: w.sources.sort((a,b) => a.id.localeCompare(b.id)), rows: await work(),
    hours: w.hours.sort((a,b) => a.shiftId.localeCompare(b.shiftId) || a.hourStartMs-b.hourStartMs),
    breaks: await db.staffBreak.findMany({ where: { date }, orderBy: { id: "asc" } }) });
}
async function edit(shiftId: string, hour: number, stationId: string | null) {
  const w = await world(), source = w.sources.find(s => s.id === shiftId)!;
  if (mode === "prepared") {
    const existing = await db.assignment.findFirstOrThrow({ where: { shiftId, hourStart: chicagoHourStart(date,hour) } });
    if (stationId) await db.assignment.update({ where: { id: existing.id }, data: { stationId, seatNumber: null } });
    else await db.assignment.delete({ where: { id: existing.id } });
    return;
  }
  const receipt = await paintV2({ protocol: 2, requestId: randomUUID(), capabilitySha256: CAPABILITY_SHA256, board: "caja", date,
    expected: { databaseEpoch: w.state!.databaseEpoch, worldRevision: w.revision! },
    sources: [{ shiftId, employeeId: source.employeeId, date, board: "caja", sourcePosition: source.sourcePosition, startAt: source.startAt.toISOString(), endAt: source.endAt.toISOString(), supersededAt: null, boardRemoved: false }],
    hours: w.hours.filter(h => h.shiftId === shiftId).map(h => ({ shiftId, hourStart: new Date(h.hourStartMs).toISOString(), revision: h.revision, ...(h.revision === null ? { legacySha256: h.legacySha256 } : {}) })),
    intents: [0,15,30,45].map(m => ({ shiftId, quarter: `${hour}:${String(m).padStart(2,"0")}`, ...(stationId ? { action: "station", stationId } : { action: "erase" }) })) },
    { id: "quarter-rehearsal-owner", name: "Synthetic Owner" }, new Date(base-minute*60), db);
  operations.push({ label: "manager-edit", shiftId, hour, stationId, receipt });
}
async function battery() {
  assert.equal((await world()).sources.length, 0, "fixture date occupied");
  await mapping("nieves"); const first = await imported("initial", rows);
  const assigned = first.rows, seated = [...new Set(assigned.map(s => s.shiftId))], sources = (await world()).sources;
  check("eligible-two-seats", () => { assert.equal(seated.length, 2); assert.deepEqual([...new Set(assigned.map(s => s.stationId))].sort(), ["nieves","nieves2"]); assert.deepEqual([...new Set(assigned.map(s => s.seatNumber))].sort(), [1,2]); });
  const unassigned = sources.find(s => !seated.includes(s.id))!;
  check("identified-capacity", () => {
    assert(unassigned); assert.equal(assigned.filter(s => s.shiftId === unassigned.id).length, 0);
    if (mode !== "prepared") {
      const result = first.receipts.map(r => JSON.parse(r.responseJson)).find(r => r.result?.fixedSkipped?.some((s: {shiftId:string}) => s.shiftId === unassigned.id));
      const skips = result.result.fixedSkipped.filter((s: {shiftId:string}) => s.shiftId === unassigned.id);
      assert(skips.every((s: {employeeId:string;workerName:string;date:string;reason:string}) => s.employeeId === unassigned.employeeId && s.workerName.endsWith(" Synthetic") && s.date === date && s.reason === "NO_ELIGIBLE_FREE_SEAT"));
      assert.equal(skips.reduce((n: number,s: {startAt:string;endAt:string}) => n+Date.parse(s.endAt)-Date.parse(s.startAt),0),180*minute);
    }
  });
  const stable = await snapshot(); await imported("repeat", rows, date, mode === "prepared" ? "refused" : "replayed");
  assert.deepEqual(await snapshot(),stable); checks.push("repeat-stable");
  await edit(seated[0],10,null); await edit(seated[1],11,"green1");
  const a = sources.find(s => s.id === seated[0])!, b = sources.find(s => s.id === seated[1])!;
  await db.staffBreak.create({ data: { employeeId:a.employeeId,shiftId:a.id,board:"caja",date,startAt:new Date(base+120*minute),endAt:new Date(base+135*minute),actor:"Synthetic",coverEmployeeId:b.employeeId,coverShiftId:b.id } });
  const saved = await snapshot();
  await imported("revision", [...rows,{id:"Dora",start:240,end:300}]);
  const revised = await snapshot();
  check("saved-intent", () => {
    assert.deepEqual(revised.rows.filter(r => sources.some(s => s.id === r.shiftId)),saved.rows);
    assert.deepEqual(revised.breaks,saved.breaks);
    assert.equal(revised.rows.some(r=>r.shiftId===unassigned.id),false);
    assert.equal(revised.rows.some(r=>r.shiftId===a.id && r.startMs<base+60*minute),false);
    assert(revised.rows.some(r=>r.shiftId===b.id && r.stationId==="green1"));
  });
  const partial = await imported("exact",[{id:"ExactA",start:10,end:35},{id:"ExactB",start:20,end:45},{id:"ExactC",start:35,end:50}],dayAfter(1));
  check("exact-intervals", () => {
    const total = partial.rows.reduce((n,r)=>n+r.endMs-r.startMs,0)/minute;
    assert.equal(total,mode==="prepared"?50:65);
    for(const r of partial.rows){ const source=partial.sources.find(s=>s.id===r.shiftId)!; assert(r.startMs>=Date.parse(String(source.startAt))); assert(r.endMs<=Date.parse(String(source.endAt))); }
  });
  for (const [index,station] of [null,"nieves2","green1"].entries()) {
    await mapping(station); const mapped=await imported(`mapping-${index}`,[{id:`Map${index}A`},{id:`Map${index}B`}],dayAfter(2+index));
    check(`mapping-${index}`,()=>assert.deepEqual([...new Set(mapped.rows.map(r=>r.stationId))],station?[station]:[]));
  }
  await mapping("nieves");
  const split = await imported("split",[{id:"SplitA"},{id:"SplitA",start:120,end:180},{id:"SplitB",start:60,end:120}],dayAfter(5));
  check("split-nonoverlap",()=>{assert.equal(new Set(split.rows.map(r=>r.shiftId)).size,3);assert.deepEqual([...new Set(split.rows.map(r=>r.stationId))],["nieves"]);});
  const employee=await db.employee.create({data:{externalId:prefix+"Forbidden",firstName:"Forbidden",lastName:"Synthetic"}});
  await db.employeeStationAbility.create({data:{employeeId:employee.id,stationId:"nieves",level:"forbidden"}});
  const forbidden=await imported("eligibility",[{id:"Forbidden"}],dayAfter(6));
  check("eligibility",()=>assert.deepEqual([...new Set(forbidden.rows.map(r=>r.stationId))],["nieves2"]));
  return { saved: await snapshot(), input: [...rows,{id:"Dora",start:240,end:300}] };
}
async function main() {
  await boundary.assertSyntheticDatabase(db);
  assert.equal(manifest.role,mode==="recovered"?"QP_COMPAT_R0":"QP_UI_Q1");
  assert.equal((await world()).state!.phase,mode==="prepared"?"prepared":"active");
  const originalMap=await db.positionStationMap.findUnique({where:{position:"Caja - Nieves"}});
  let state;
  let before: Awaited<ReturnType<typeof snapshot>> | undefined;
  try {
    if(mode==="prepared"||mode==="seed") state=await battery();
    else {
      const prior=JSON.parse(readFileSync(priorFile,"utf8")); before=await snapshot(); const crossing=before;
      check("crossing-preserved",()=>assert.deepEqual(crossing,prior.state.saved));
      await mapping("nieves"); await imported("crossing-repeat",prior.state.input,date,"replayed");
      assert.deepEqual(await snapshot(),before); checks.push("crossing-repeat");
      if(mode==="recovered") {
        const baseline=await imported("r0-existing-allocator",[{id:"OldA"},{id:"OldB"}],dayAfter(20));
        check("r0-single-seat-baseline",()=>{assert.deepEqual([...new Set(baseline.rows.map(r=>r.stationId))],["nieves"]);assert.equal(new Set(baseline.rows.map(r=>r.shiftId)).size,1);});
        state=prior.state;
      } else {
        const next=[...prior.state.input,{id:"Returned",start:360,end:420}];
        await imported("returned-revision",next);
        const final=await snapshot();
        check("returned-revision-preserves",()=>{assert.deepEqual(final.rows.filter(r=>crossing.sources.some(s=>s.id===r.shiftId)),crossing.rows);assert.deepEqual(final.breaks,crossing.breaks);});
        state={saved:final,input:next};
      }
    }
  } finally {
    if(originalMap)await db.positionStationMap.update({where:{position:"Caja - Nieves"},data:{stationId:originalMap.stationId}});
    else await db.positionStationMap.deleteMany({where:{position:"Caja - Nieves"}});
  }
  artifact.assertLoadedArtifactIdentity(true);
  const file=boundary.syntheticDatabasePath(),stat=statSync(file);
  writeFileSync(output,JSON.stringify({version:1,mode,date,loadedArtifactSha256:artifact.loadedArtifactSha256,sourceSha:manifest.sourceSha,role:manifest.role,
    database:{path:file,device:stat.dev,inode:stat.ino},driverSha256:createHash("sha256").update(readFileSync(__filename)).digest("hex"),checks,operations,before,state},null,2)+"\n",{flag:"wx"});
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.$disconnect());
