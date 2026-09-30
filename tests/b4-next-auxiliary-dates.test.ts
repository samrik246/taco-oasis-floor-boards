import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { signManagerSession } from "@/lib/managers/session";
import { chicagoToday } from "@/lib/upcoming/source";
import { chicagoDateOffset } from "@/lib/date-math";
import { chicagoDateTime } from "@/lib/time";
import { GET as notes, POST as createNote } from "@/app/api/notes/route";
import { PUT as editNote, DELETE as removeNote } from "@/app/api/notes/[id]/route";
import { GET as hours } from "@/app/api/employees/[id]/hours/route";
import { GET as performance, POST as answer } from "@/app/api/performance/route";
import { POST as tarea, PATCH as complete } from "@/app/api/tareas/route";
import { PATCH as acknowledge } from "@/app/api/return-prompts/route";
import { POST as move } from "@/app/api/position-moves/route";
import { POST as upload } from "@/app/api/imports/route";
import { GET as sample } from "@/app/api/sample/route";
import { syntheticCsv } from "./helpers/synthetic-schedule";

const db = new PrismaClient();
const today = chicagoToday();
const dates = [chicagoDateOffset(today, -2), today, chicagoDateOffset(today, 2)];
const tag = `aux-${Date.now()}`;
let person: string;
let manager: string;
let owner: string;
const managerIds: string[] = [];
const noteIds: string[] = [];
const assignments = new Map<string, string>();
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function req(token: string | null, method = "GET", body?: unknown, query = "") {
  return new Request(`http://local/api${query}`, { method, headers: {
    "content-type": "application/json", ...(token ? { "x-manager-session": token } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("dated auxiliary APIs honor requested and persisted dates", () => {
  beforeAll(async () => {
    for (const role of ["manager", "owner"]) {
      const row = await db.manager.create({ data: { name: `${tag}-${role}`, role, codeHash: "synthetic-unused" } });
      managerIds.push(row.id);
      if (role === "manager") manager = signManagerSession(row); else owner = signManagerSession(row);
    }
    person = (await db.employee.create({ data: { externalId: tag, firstName: "Synthetic", lastName: "Boundary" } })).id;
    for (const date of dates) {
      const shift = await db.shift.create({ data: { employeeId: person, date, board: "caja", sourcePosition: "Caja", startAt: chicagoDateTime(date, "8:00 am"), endAt: chicagoDateTime(date, "4:00 pm") } });
      const row = await db.assignment.create({ data: { shiftId: shift.id, stationId: "green1", hourStart: chicagoDateTime(date, "9:00 am"), hourEnd: chicagoDateTime(date, "10:00 am") } });
      assignments.set(date, row.id);
    }
  });
  afterAll(async () => {
    await db.managerNote.deleteMany({ where: { id: { in: noteIds } } });
    await db.positionMoveLog.deleteMany({ where: { employeeId: person } });
    await db.returnPrompt.deleteMany({ where: { employeeId: person } });
    await db.performanceAnswer.deleteMany({ where: { employeeId: person } });
    await db.tareaAssignment.deleteMany({ where: { employeeId: person } });
    await db.assignment.deleteMany({ where: { shift: { employeeId: person } } });
    await db.shift.deleteMany({ where: { employeeId: person } });
    await db.employee.delete({ where: { id: person } });
    await db.boardChangeLog.deleteMany({ where: { managerId: { in: managerIds } } });
    await db.manager.deleteMany({ where: { id: { in: managerIds } } });
    await db.$disconnect();
  });
  it.each(dates)("notes authorize requested/stored date %s without denied mutations", async date => {
    const body = { board: "caja", date, body: "Original" };
    const created = await createNote(req(owner, "POST", body));
    expect(created.status).toBe(201);
    const id = (await created.json()).note.id; noteIds.push(id);
    const allowed = date === today;
    expect((await notes(req(manager, "GET", undefined, `?board=caja&date=${date}`))).status).toBe(allowed ? 200 : 403);
    const made = await createNote(req(manager, "POST", body));
    expect(made.status).toBe(allowed ? 201 : 403);
    if (allowed) noteIds.push((await made.json()).note.id);
    expect((await editNote(req(manager, "PUT", { body: "Changed" }), context(id))).status).toBe(allowed ? 200 : 403);
    expect((await removeNote(req(manager, "DELETE"), context(id))).status).toBe(allowed ? 200 : 403);
    if (!allowed) expect((await db.managerNote.findUniqueOrThrow({ where: { id } })).body).toBe("Original");
    expect((await notes(req(owner, "GET", undefined, `?board=caja&date=${date}`))).status).toBe(200);
    if (!allowed) {
      expect((await editNote(req(owner, "PUT", { body: "Owner" }), context(id))).status).toBe(200);
      expect((await removeNote(req(owner, "DELETE"), context(id))).status).toBe(200);
    }
  });
  it.each([undefined, ...dates])("weekly station and tarea hours require owner for weekOf %s", async date => {
    const query = date ? `?weekOf=${date}` : "";
    expect((await hours(req(manager, "GET", undefined, query), context(person))).status).toBe(403);
    expect((await hours(req(null, "GET", undefined, query), context(person))).status).toBe(401);
    const response = await hours(req(owner, "GET", undefined, query), context(person));
    expect(response.status).toBe(200);
    expect((await response.json()).totalMinutes).toBeGreaterThan(0);
  });
  it.each(dates)("performance answers protect date %s and retain owner/today access", async date => {
    const catalog = await performance(req(manager));
    const questionId = (await catalog.json()).questions[0].id;
    const body = { board: "caja", date, employeeId: person, answers: [{ questionId, value: "Original" }] };
    expect((await answer(req(owner, "POST", body))).status).toBe(200);
    const allowed = date === today;
    expect((await performance(req(manager, "GET", undefined, `?board=caja&date=${date}`))).status).toBe(allowed ? 200 : 403);
    expect((await answer(req(manager, "POST", { ...body, answers: [{ questionId, value: "Changed" }] }))).status).toBe(allowed ? 200 : 403);
    const saved = await db.performanceAnswer.findFirstOrThrow({ where: { date, employeeId: person, questionId } });
    expect(saved.value).toBe(allowed ? "Changed" : "Original");
    expect((await performance(req(owner, "GET", undefined, `?board=caja&date=${date}`))).status).toBe(200);
  });
  it("rejects malformed and impossible dates before dated operations", async () => {
    for (const date of ["not-a-date", "2040-02-30"]) {
      expect((await performance(req(owner, "GET", undefined, `?board=caja&date=${date}`))).status).toBe(422);
      expect((await answer(req(owner, "POST", { date, board: "caja", employeeId: person, answers: [] }))).status).toBe(422);
      expect((await createNote(req(owner, "POST", { date, board: "caja", body: "No" }))).status).toBe(400);
    }
  });
  it.each(dates)("tareas and return prompts protect stored date %s while staff complete today", async date => {
    const body = { date, employeeId: person, templateId: "positions", hour: 9 };
    const allowed = date === today;
    const count = await db.tareaAssignment.count({ where: { date, employeeId: person } });
    expect((await tarea(req(manager, "POST", body))).status).toBe(allowed ? 200 : 403);
    expect(await db.tareaAssignment.count({ where: { date, employeeId: person } })).toBe(count + (allowed ? 1 : 0));
    const created = await tarea(req(owner, "POST", body));
    expect(created.status).toBe(200);
    const id = (await created.json()).assignment.id;
    expect((await complete(req(null, "PATCH", { id, status: "done" }))).status).toBe(allowed ? 200 : 401);
    expect((await complete(req(manager, "PATCH", { id, status: "done" }))).status).toBe(allowed ? 200 : 403);
    expect((await db.tareaAssignment.findUniqueOrThrow({ where: { id } })).status).toBe(allowed ? "done" : "working");
    expect((await complete(req(owner, "PATCH", { id, status: "done" }))).status).toBe(200);
    const prompt = await db.returnPrompt.create({ data: { date, employeeId: person, loadStationId: "green", seatId: "green1", message: "Synthetic return" } });
    expect((await acknowledge(req(null, "PATCH", { id: prompt.id }))).status).toBe(allowed ? 200 : 401);
    expect((await acknowledge(req(manager, "PATCH", { id: prompt.id }))).status).toBe(allowed ? 200 : 403);
    expect((await db.returnPrompt.findUniqueOrThrow({ where: { id: prompt.id } })).acknowledgedAt !== null).toBe(allowed);
    expect((await acknowledge(req(owner, "PATCH", { id: prompt.id }))).status).toBe(200);
  });
  it.each(dates)("move logs check date %s and mismatched assignment dates", async date => {
    const body = { date, hour: 9, employeeId: person, reason: "Other", assignmentId: assignments.get(date) };
    const allowed = date === today;
    const count = await db.positionMoveLog.count({ where: { employeeId: person } });
    expect((await move(req(manager, "POST", body))).status).toBe(allowed ? 200 : 403);
    expect(await db.positionMoveLog.count({ where: { employeeId: person } })).toBe(count + (allowed ? 1 : 0));
    if (!allowed) {
      expect((await move(req(manager, "POST", { ...body, date: today }))).status).toBe(403);
      expect(await db.positionMoveLog.count({ where: { employeeId: person } })).toBe(count);
    }
    expect((await move(req(owner, "POST", body))).status).toBe(200);
  });
  it("upload preview/commit denies any non-today date before schedule mutation; sample requires owner", async () => {
    const rows = dates.map(date => ({ date, employeeId: "aux-upload-synthetic", firstName: "Synthetic", lastName: "Upload", position: "Caja - Regular", start: "8:00 am", end: "4:00 pm" }));
    const file = syntheticCsv(rows);
    for (const mode of ["preview", "commit"]) {
      const response = await upload(new Request(`http://local/api/imports?filename=synthetic.csv&mode=${mode}`, { method: "POST", headers: { "x-manager-session": manager }, body: new Uint8Array(file) }));
      expect(response.status).toBe(403);
    }
    expect(await db.employee.findUnique({ where: { externalId: "aux-upload-synthetic" } })).toBeNull();
    expect((await sample(req(manager))).status).toBe(403);
  });
});
