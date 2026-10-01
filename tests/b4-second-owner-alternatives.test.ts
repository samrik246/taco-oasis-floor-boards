import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadManagedBreak, saveManagedBreak } from "@/lib/breaks/manage";
import { loadMyBreak } from "@/lib/breaks/mine";
import { breakTimeline } from "@/lib/breaks/timeline";
import { saveBreak } from "@/lib/breaks/rules";
import { POST, GET } from "@/app/api/breaks/manage/route";
import { signManagerSession } from "@/lib/managers/session";
import { managerAuthHeaders } from "@/lib/managers/auth-headers";
import { hashManagerCode } from "@/lib/managers/codes";
import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { chicagoDateTime } from "@/lib/time";
const db = new PrismaClient();
const date = "2046-06-06";
const at = (s: string) => chicagoDateTime(date, s);
const tag = `second-owner-${Date.now()}`;
const priorSecret = process.env.MANAGER_SESSION_SECRET;
const priorNow = process.env.FLOOR_BOARDS_E2E_NOW;
const ids: string[] = [];
let asker: string, cover: string, coverShift: string;
let manager: { id: string; name: string; kind: "manager" };
let token: string;
const read = () => loadManagedBreak({ employeeId: asker, board: "cocina", now: at("9:30 am") });
const row = () => db.staffBreak.findUniqueOrThrow({ where: { employeeId_date: { employeeId: asker, date } } });
const act = (revision: { id: string; updatedAt: string }, extra = {}) => saveManagedBreak({ manager, board: "cocina", employeeId: asker, startAt: at("3:00 pm"), endAt: at("3:30 pm"), coverEmployeeId: cover, now: at("9:30 am"), resolvePending: revision, ...extra });
const request = (body: unknown) => new Request("http://local/api/breaks/manage", { method: "POST", headers: { "content-type": "application/json", ...managerAuthHeaders(token) }, body: JSON.stringify(body) });

beforeAll(async () => {
  process.env.MANAGER_SESSION_SECRET = "second-owner-synthetic-test-secret-00000";
  process.env.FLOOR_BOARDS_E2E_NOW = at("9:30 am").toISOString();
  const m = await db.manager.create({ data: { name: "Test Owner", role: "owner", active: true, codeHash: hashManagerCode("synthetic-second-owner") } });
  manager = { id: m.id, name: m.name, kind: "manager" }; token = signManagerSession(m);
  for (const [index, stationId] of [...MANDATORY_STATIONS_BY_BOARD.cocina, null].entries()) {
    const person = await db.employee.create({ data: { externalId: `${tag}-${index}`, firstName: stationId ? `Seat${index}` : "Sol", lastName: "Example" } });
    ids.push(person.id);
    const shift = await db.shift.create({ data: { employeeId: person.id, date, board: "cocina", sourcePosition: "Cocina", startAt: at(stationId ? "8:00 am" : "3:00 pm"), endAt: at("4:00 pm") } });
    if (stationId === "pdf_guia") asker = person.id;
    if (stationId) await db.assignment.createMany({ data: Array.from({ length: 8 }, (_, i) => ({ employeeId: person.id, shiftId: shift.id, stationId, hourStart: new Date(at("8:00 am").getTime() + i * 3600000), hourEnd: new Date(at("8:00 am").getTime() + (i+1) * 3600000) })) });
    else { cover = person.id; coverShift = shift.id; }
  }
});
beforeEach(async () => {
  await db.manager.update({ where: { id: manager.id }, data: { active: true } });
  await db.shift.update({ where: { id: coverShift }, data: { boardRemoved: false } });
  await db.employeeStationAbility.deleteMany({ where: { employeeId: cover } });
  await db.staffBreak.deleteMany({ where: { date } });
  const pending = await saveBreak({ employeeId: asker, date, startAt: at("2:00 pm"), endAt: at("2:30 pm") });
  expect(pending.status).toBe("pending");
});
afterAll(async () => {
  await db.staffBreak.deleteMany({ where: { date } });
  await db.employeeStationAbility.deleteMany({ where: { employeeId: { in: ids } } });
  await db.assignment.deleteMany({ where: { employeeId: { in: ids } } });
  await db.shift.deleteMany({ where: { employeeId: { in: ids } } });
  await db.employee.deleteMany({ where: { id: { in: ids } } });
  await db.manager.delete({ where: { id: manager.id } });
  await db.boardChangeLog.deleteMany({ where: { date } });
  await db.$disconnect();
  if (priorSecret === undefined) delete process.env.MANAGER_SESSION_SECRET; else process.env.MANAGER_SESSION_SECRET = priorSecret;
  if (priorNow === undefined) delete process.env.FLOOR_BOARDS_E2E_NOW; else process.env.FLOOR_BOARDS_E2E_NOW = priorNow;
});

describe("resolve a pending BREAK at another time", () => {
  it("reads feasible future same-day fixed-duration automatic/covered alternatives without writes", async () => {
    const before = await row(); const logs = await db.boardChangeLog.count({ where: { date } });
    const data = await read();
    expect(data.covers).toEqual([]);
    expect(data.pendingRevision).toEqual({ id: before.id, updatedAt: before.updatedAt.toISOString() });
    expect(data.alternatives.some(s => s.approval === "automatic" && s.cover === null)).toBe(true);
    expect(data.alternatives.find(s => s.startAt === at("3:00 pm").toISOString())?.cover).toMatchObject({ kind: "simple", employeeId: cover, positions: [{ vacatedStationId: "pdf_guia" }] });
    expect(data.alternatives.every(s => Date.parse(s.startAt) > at("9:30 am").getTime() && Date.parse(s.endAt) - Date.parse(s.startAt) === 30*60000)).toBe(true);
    expect(data.alternatives.some(s => s.startAt === before.startAt.toISOString())).toBe(false);
    expect(await row()).toEqual(before); expect(await db.boardChangeLog.count({ where: { date } })).toBe(logs);
  });
  it("books an API tap, updates the public timeline and worker, with no paint writes", async () => {
    const data = await read(); const paint = await db.assignment.findMany({ where: { employeeId: { in: ids } }, orderBy: { id: "asc" } });
    const response = await POST(request({ board: "cocina", employeeId: asker, startAt: at("3:00 pm").toISOString(), endAt: at("3:30 pm").toISOString(), coverEmployeeId: cover, resolvePending: data.pendingRevision }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ waiting: false, replaced: true });
    expect(await row()).toMatchObject({ status: "booked", coverEmployeeId: cover, startAt: at("3:00 pm"), endAt: at("3:30 pm") });
    expect((await breakTimeline(date, at("9:30 am"))).breaks.find(b => b.employeeId === asker)).toMatchObject({ state: "reserved", startAt: at("3:00 pm").toISOString() });
    expect((await loadMyBreak({ employeeId: asker, board: "cocina", exp: Date.now()+60000 }, at("9:30 am"))).saved).toMatchObject({ state: "reserved", startAt: at("3:00 pm").toISOString() });
    expect(await db.assignment.findMany({ where: { employeeId: { in: ids } }, orderBy: { id: "asc" } })).toEqual(paint);
  });
  it("books an automatic alternative without naming an unnecessary cover", async () => {
    const data = await read(); const slot = data.alternatives.find(s => s.approval === "automatic")!;
    expect(await act(data.pendingRevision!, { startAt: new Date(slot.startAt), endAt: new Date(slot.endAt), coverEmployeeId: undefined })).toMatchObject({ status: "booked" });
  });
  it("rejects stale revision and concurrent taps without replacing the first result", async () => {
    const revision = (await read()).pendingRevision!;
    const results = await Promise.allSettled([act(revision), act(revision)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const saved = await row(); await expect(act(revision)).rejects.toMatchObject({ code: "LOCK_CONFLICT" }); expect(await row()).toEqual(saved);
  });
  it("preserves the pending original after cover removal or ability invalidation", async () => {
    const data = await read(); const before = await row();
    await db.shift.update({ where: { id: coverShift }, data: { boardRemoved: true } });
    await expect(act(data.pendingRevision!)).rejects.toMatchObject({ code: "BAD_COVER" }); expect(await row()).toEqual(before);
    await db.shift.update({ where: { id: coverShift }, data: { boardRemoved: false } });
    await db.employeeStationAbility.create({ data: { employeeId: cover, stationId: "pdf_guia", level: "forbidden" } });
    await expect(act(data.pendingRevision!)).rejects.toMatchObject({ code: "BAD_COVER" }); expect(await row()).toEqual(before);
  });
  it("never calls an uncovered alternative approved, never shortens or moves to past/other day", async () => {
    const revision = (await read()).pendingRevision!; const before = await row();
    await expect(act(revision, { coverEmployeeId: undefined })).rejects.toMatchObject({ code: "NEEDS_COVER" });
    await expect(act(revision, { endAt: at("3:15 pm") })).rejects.toMatchObject({ code: "ALLOWANCE" });
    await expect(act(revision, { startAt: at("9:00 am"), endAt: at("9:30 am"), coverEmployeeId: undefined })).rejects.toMatchObject({ code: "NOT_TODAY" });
    await expect(act(revision, { startAt: chicagoDateTime("2046-06-07", "3:00 pm"), endAt: chicagoDateTime("2046-06-07", "3:30 pm") })).rejects.toMatchObject({ code: "NOT_TODAY" });
    expect(await row()).toEqual(before);
  });
  it("requires current authority in both API and lock and shows no alternatives once none can resolve", async () => {
    const revision = (await read()).pendingRevision!; const before = await row();
    await db.manager.update({ where: { id: manager.id }, data: { active: false } });
    await expect(act(revision)).rejects.toMatchObject({ code: "GERENTE_REQUIRED" });
    const response = await GET(new Request(`http://local/api/breaks/manage?board=cocina&employeeId=${asker}`, { headers: managerAuthHeaders(token) }));
    expect([401,403]).toContain(response.status); expect(await row()).toEqual(before);
    await db.shift.update({ where: { id: coverShift }, data: { boardRemoved: true } });
    const data = await loadManagedBreak({ employeeId: asker, board: "cocina", now: at("1:30 pm") });
    expect(data.alternatives).toEqual([]); expect(data.state).toBe("pending");
  });
});
