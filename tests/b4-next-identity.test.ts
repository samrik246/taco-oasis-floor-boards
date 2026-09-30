import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { gerenteAuthority } from "@/lib/breaks/authority";
import { signInWithCode } from "@/lib/breaks/sign-in";
import { hashStaffPasscode, newPasscodeSalt } from "@/lib/breaks/passcode";
import { hashManagerCode } from "@/lib/managers/codes";
import { readStaffSession } from "@/lib/breaks/session";
import { signManagerSession } from "@/lib/managers/session";
import { loadMyBreak, saveMyBreak, clearMyBreak } from "@/lib/breaks/mine";
import { requireDayAccess } from "@/lib/managers/day-access";
import { pairingData, pairManager } from "@/lib/managers/pairing";
import { GET as readPairings, PUT as writePairing } from "@/app/api/admin/manager-pairings/route";
import { POST as manageBreak } from "@/app/api/breaks/manage/route";
import { breakTimeline } from "@/lib/breaks/timeline";
import { chicagoDateTime } from "@/lib/time";

const db = new PrismaClient();
const date = "2040-06-06";
const now = chicagoDateTime(date, "8:00 am");
const at = (time: string) => chicagoDateTime(date, time);
const tag = `b4next-${Date.now()}`;
const pepper = "b4-next-synthetic-pepper-0000000000";
const secret = "b4-next-synthetic-session-secret-0000";
const oldPepper = process.env.STAFF_PASSCODE_PEPPER;
const oldSecret = process.env.MANAGER_SESSION_SECRET;
let seq = 0;
const people: string[] = [];
const managers: string[] = [];
async function employee(board = "cocina", position = "Cocina", start = "7:00 am", end = "8:00 pm") {
  const p = await db.employee.create({ data: { externalId: `${tag}-${seq++}`, firstName: "Synthetic", lastName: "Person" } });
  people.push(p.id);
  const shift = await db.shift.create({ data: { employeeId: p.id, board, sourcePosition: position, date, startAt: at(start), endAt: at(end) } });
  return { ...p, shift };
}
async function manager(employeeId: string | null, code: string, role = "manager") {
  const m = await db.manager.create({ data: { name: `${tag}-${seq++}`, employeeId, codeHash: hashManagerCode(code), role } });
  managers.push(m.id); return m;
}
async function code(employeeId: string, value: string) {
  const salt = newPasscodeSalt();
  await db.staffPasscode.create({ data: { employeeId, salt: salt.toString("hex"), hash: (await hashStaffPasscode(value, salt, pepper)).toString("hex") } });
}
function request(token: string, body?: unknown) {
  return new Request("http://local/api", { method: body ? "POST" : "GET", headers: { "x-manager-session": token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function token(m: { id: string; name: string }) { return signManagerSession(m); }
async function attempts() { await db.staffPasscodeAttempt.deleteMany(); }

describe("B4 next identity, linkage, revocation and cross-board contracts", () => {
  beforeAll(() => { process.env.STAFF_PASSCODE_PEPPER = pepper; process.env.MANAGER_SESSION_SECRET = secret; });
  afterEach(async () => { vi.useRealTimers(); await attempts(); });
  afterAll(async () => {
    if (oldPepper === undefined) delete process.env.STAFF_PASSCODE_PEPPER; else process.env.STAFF_PASSCODE_PEPPER = oldPepper;
    if (oldSecret === undefined) delete process.env.MANAGER_SESSION_SECRET; else process.env.MANAGER_SESSION_SECRET = oldSecret;
    await db.staffBreak.deleteMany({ where: { employeeId: { in: people } } });
    await db.staffPasscode.deleteMany({ where: { employeeId: { in: people } } });
    await db.shift.deleteMany({ where: { employeeId: { in: people } } });
    await db.employee.deleteMany({ where: { id: { in: people } } });
    await db.manager.deleteMany({ where: { id: { in: managers } } });
    await db.boardChangeLog.deleteMany({ where: { OR: [{ managerId: { in: [...managers, ...people] } }, { date }] } });
    await db.$disconnect();
  });
  it("grants before a future gerente shift, revokes at its end/removal/supersession, never from a mapped seat", async () => {
    const p = await employee("caja", "Caja Manager", "2:00 pm", "6:00 pm");
    const m = await manager(p.id, "future-gerente-code");
    expect(await gerenteAuthority(m.id, now)).not.toBeNull();
    expect(await gerenteAuthority(m.id, at("6:00 pm"))).toBeNull();
    await db.shift.update({ where: { id: p.shift.id }, data: { boardRemoved: true } });
    expect(await gerenteAuthority(m.id, now)).toBeNull();
    await db.shift.update({ where: { id: p.shift.id }, data: { boardRemoved: false, supersededAt: now } });
    expect(await gerenteAuthority(m.id, now)).toBeNull();
    await db.shift.update({ where: { id: p.shift.id }, data: { supersededAt: null, sourcePosition: "Caja - GM" } });
    expect(await gerenteAuthority(m.id, now)).toBeNull();
    const owner = await manager(null, "owner-synthetic", "owner");
    expect(await gerenteAuthority(owner.id, at("11:00 pm"))).not.toBeNull();
  });
  it("resolves a worker from the opposite tablet and refuses a cross-board collision", async () => {
    const p = await employee("caja"); await code(p.id, "9173");
    const hit = await signInWithCode("cocina", "9173", now);
    expect(hit.ok).toBe(true);
    if (hit.ok) { expect(hit.kind).toBe("staff"); expect(readStaffSession(hit.token)?.employeeId).toBe(p.id); }
    const q = await employee("cocina"); await code(q.id, "9173");
    expect(await signInWithCode("caja", "9173", now)).toMatchObject({ ok: false, status: 409 });
  });
  it("accepts 64-character gerente credentials, permits own-worker fallback, and rejects ambiguous elevation", async () => {
    const p = await employee("cocina", "Cocina Guia Abrir");
    const m = await manager(p.id, "a".repeat(64));
    expect(await signInWithCode("caja", "a".repeat(64), now)).toMatchObject({ ok: true, kind: "gerente" });
    await db.shift.update({ where: { id: p.shift.id }, data: { sourcePosition: "Cocina" } });
    expect(await signInWithCode("caja", "a".repeat(64), now)).toMatchObject({ ok: true, kind: "staff" });
    await db.manager.update({ where: { id: m.id }, data: { active: false } });
    expect(await signInWithCode("caja", "a".repeat(64), now)).toMatchObject({ ok: false, status: 401 });
    const q = await employee(); await code(q.id, "9472");
    await manager(null, "9472", "owner");
    expect(await signInWithCode("caja", "9472", now)).toMatchObject({ ok: false, status: 409 });
  });
  it("keeps the pause effective even for a correct manager code", async () => {
    await manager(null, "rate-test-owner", "owner");
    for (let i = 0; i < 5; i++) await signInWithCode("caja", "bad-synthetic", now);
    expect(await signInWithCode("caja", "rate-test-owner", now)).toMatchObject({ ok: false, status: 423 });
  });
  it("pairing is explicit, owner-only, deduplicated, and reveals no credential fields", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const p = await employee("cocina", "Cocina Guia Cerrar");
    const m = await manager(null, "pairing-worker");
    const owner = await manager(null, "pairing-owner", "owner");
    expect(await pairManager(m.id, m.id, p.id)).toMatchObject({ ok: false, status: 403 });
    expect((await readPairings(request(token(m)))).status).toBe(403);
    expect((await writePairing(request(token(owner), { managerId: m.id, employeeId: p.id }))).status).toBe(400);
    expect(await pairManager(owner.id, m.id, p.id)).toMatchObject({ ok: true });
    expect(await gerenteAuthority(m.id, now)).not.toBeNull();
    const body = await pairingData(now);
    expect(body.people.filter(x => x.id === p.id)).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/codeHash|salt|pairing-worker|pairing-owner/);
    expect(await pairManager(owner.id, m.id, null)).toMatchObject({ ok: true });
    expect(await gerenteAuthority(m.id, now)).toBeNull();
  });
  it("existing ordinary sessions cannot browse other days or manage breaks; owner can read other dates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const m = await manager(null, "ordinary-unpaired");
    const owner = await manager(null, "owner-date", "owner");
    expect(await requireDayAccess(request(token(m)), "2040-06-07", now)).toMatchObject({ ok: false });
    expect(await requireDayAccess(request(token(owner)), "2040-06-07", now)).toMatchObject({ ok: true });
    expect((await manageBreak(request(token(m), { board: "caja", employeeId: "irrelevant" }))).status).toBe(403);
  });
  it("saves, reads and clears by covering-shift board, ignoring the token board", async () => {
    const p = await employee("caja");
    const claims = { employeeId: p.id, board: "cocina" as const, exp: Date.now() + 60_000 };
    expect(await saveMyBreak(claims, at("9:00 am"), at("9:15 am"), now)).toMatchObject({ ok: true });
    const row = await db.staffBreak.findUniqueOrThrow({ where: { employeeId_date: { employeeId: p.id, date } } });
    expect(row.board).toBe("caja");
    expect((await loadMyBreak(claims, now)).saved).toMatchObject({ board: "caja", state: "reserved" });
    await db.staffBreak.update({ where: { id: row.id }, data: { status: "pending" } });
    expect((await loadMyBreak(claims, now)).saved).toMatchObject({ status: "pending", approval: "gerente" });
    expect((await breakTimeline(date, now)).breaks.find(b => b.id === row.id)?.state).toBe("pending");
    await db.staffBreak.update({ where: { id: row.id }, data: { status: "ended" } });
    expect((await loadMyBreak(claims, now)).saved?.state).toBe("ended");
    expect(await clearMyBreak(claims, now)).toMatchObject({ ok: true, cleared: true });
    expect(await saveMyBreak(claims, at("6:00 am"), at("6:15 am"), now)).toMatchObject({ ok: false });
  });
});
