/**
 * B3 S2: owner abilities grid, secret reads and writes, assignment refusal stays.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { POST as favorite } from "@/app/api/abilities/favorite/route";
import { GET as abilityGrid, PUT as saveAbility } from "@/app/api/admin/abilities/route";
import { PUT as assignHour } from "@/app/api/assignments/route";
import { GET as dayBoard } from "@/app/api/boards/[board]/days/[date]/route";
import { GET as getEmployee, PATCH as patchEmployee } from "@/app/api/employees/[id]/route";
import { GET as listEmployees, POST as createEmployee } from "@/app/api/employees/route";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import * as boardChangeLog from "@/lib/board-change-log";
import { cocinaAbilityColumns, nextStoredLevel } from "@/lib/abilities/levels";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { findBoardViolations } from "@/lib/violations";
import { chicagoToday } from "@/lib/upcoming/source";
import { COCINA_STATIONS } from "@/lib/stations";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { chicagoDateTime } from "@/lib/time";

const prisma = new PrismaClient();
const stamp = `b3s2-${Date.now()}`;
const future = "2034-06-11";
const LEVEL_WORD = /\b(forbidden|training|ok|preferred|no|entrenando|bien|fuerte|mixto)\b/;

let ownerToken = "";
let managerToken = "";
let otherToken = "";
let ownerId = "";
let ownerName = "";
let niaId = "";
let beaId = "";

function authed(token: string | null, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (token) headers.set("x-manager-session", token);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Request(url, { ...init, headers });
}

async function makeManager(label: string, role: string) {
  return prisma.manager.create({
    data: {
      name: `${stamp} ${label}`,
      codeHash: hashManagerCode(`${stamp}-${label}`),
      role,
    },
  });
}

describe("B3 S2 abilities", () => {
  afterAll(async () => {
    const employees = await prisma.employee.findMany({
      where: { externalId: { startsWith: stamp } },
      select: { id: true },
    });
    const ids = employees.map((row) => row.id);
    if (ownerId) await prisma.boardChangeLog.deleteMany({ where: { managerId: ownerId } });
    if (ids.length) {
      await prisma.assignment.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.manager.deleteMany({ where: { name: { startsWith: stamp } } });
    await prisma.$disconnect();
  });

  it("B1 grid routes are 401, 403, then 200, and a non-owner role stays 403", async () => {
    for (const station of COCINA_STATIONS) {
      await prisma.station.upsert({
        where: { id: station.id },
        update: {},
        create: {
          id: station.id,
          board: station.board,
          label: station.label,
          color: station.color,
          maxConcurrent: station.maxConcurrent,
          sortOrder: station.sortOrder,
          priority: station.priority,
        },
      });
    }
    const owner = await makeManager("Owner", "owner");
    const manager = await makeManager("Manager", "manager");
    const other = await makeManager("Lead", "lead");
    ownerId = owner.id;
    ownerName = owner.name;
    ownerToken = signManagerSession({ id: owner.id, name: owner.name });
    managerToken = signManagerSession({ id: manager.id, name: manager.name });
    otherToken = signManagerSession({ id: other.id, name: other.name });

    const nia = await prisma.employee.create({
      data: {
        externalId: `${stamp}-nia`,
        firstName: "Nia",
        lastName: "Sol",
        abilities: {
          create: [
            { stationId: "pdf_pr1e", level: "forbidden" },
            { stationId: "pdf_pr2e", level: "ok" },
            { stationId: "pdf_guia", level: "forbidden" },
          ],
        },
      },
    });
    niaId = nia.id;
    const bea = await prisma.employee.create({
      data: { externalId: `${stamp}-bea`, firstName: "Bea", lastName: "West" },
    });
    beaId = bea.id;
    const hidden = await prisma.employee.create({
      data: { externalId: `${stamp}-caja`, firstName: "Caja", lastName: "Only" },
    });
    const startAt = chicagoDateTime(future, "9:00 am");
    const endAt = chicagoDateTime(future, "5:00 pm");
    await prisma.shift.createMany({
      data: [
        { employeeId: nia.id, date: future, startAt, endAt, sourcePosition: "Cocina", board: "cocina" },
        { employeeId: bea.id, date: future, startAt, endAt, sourcePosition: "Cocina", board: "cocina" },
        { employeeId: hidden.id, date: future, startAt, endAt, sourcePosition: "Caja", board: "caja" },
      ],
    });

    const url = "http://local/api/admin/abilities?board=cocina";
    expect((await abilityGrid(authed(null, url))).status).toBe(401);
    expect((await abilityGrid(authed(managerToken, url))).status).toBe(403);
    expect((await abilityGrid(authed(otherToken, url))).status).toBe(403);
    const got = await abilityGrid(authed(ownerToken, url));
    expect(got.status).toBe(200);
    const grid = await got.json();
    expect(grid.columns.map((column: { key: string }) => column.key)).toEqual(
      cocinaAbilityColumns().map((column) => column.key),
    );
    expect(grid.columns.map((column: { key: string }) => column.key)).toEqual([
      "birria",
      "pdf_crne",
      "preparacion",
      "pdf_rlno",
      "pdf_cyrl",
      "pdf_rngn",
      "tortillaFreidora",
      "trastes",
      "pdf_guia",
      "taquero",
      "pdf_pstl",
    ]);
    const names = grid.people
      .filter((person: { externalId: string }) => person.externalId.startsWith(stamp))
      .map((person: { firstName: string }) => person.firstName);
    expect(names).toEqual(["Bea", "Nia"]);
    const niaRow = grid.people.find((person: { id: string }) => person.id === niaId);
    expect(niaRow.cells.preparacion).toBe("mixed");
    expect(niaRow.cells.pdf_guia).toBe("forbidden");
    expect(niaRow.cells.pdf_crne).toBe("ok");

    const putUrl = "http://local/api/admin/abilities";
    const body = { employeeId: niaId, column: "pdf_guia", level: "training" };
    expect((await saveAbility(authed(null, putUrl, { method: "PUT", body: JSON.stringify(body) }))).status).toBe(401);
    expect((await saveAbility(authed(managerToken, putUrl, { method: "PUT", body: JSON.stringify(body) }))).status).toBe(403);
    expect((await saveAbility(authed(otherToken, putUrl, { method: "PUT", body: JSON.stringify(body) }))).status).toBe(403);
    expect((await saveAbility(authed(ownerToken, putUrl, { method: "PUT", body: JSON.stringify(body) }))).status).toBe(200);
  });

  it("B2 a family write is one transaction, and a bad column, level, or log failure writes nothing", async () => {
    const before = await prisma.employeeStationAbility.findMany({
      where: { employeeId: niaId, stationId: { in: ["pdf_pr1e", "pdf_pr2e", "pdf_pr3e"] } },
      orderBy: { stationId: "asc" },
    });
    const logsBefore = await prisma.boardChangeLog.count({ where: { managerId: ownerId } });
    const putUrl = "http://local/api/admin/abilities";

    const badColumn = await saveAbility(authed(ownerToken, putUrl, {
      method: "PUT",
      body: JSON.stringify({ employeeId: niaId, column: "pdf_pr1e", level: "ok" }),
    }));
    expect(badColumn.status).toBe(400);
    const badLevel = await saveAbility(authed(ownerToken, putUrl, {
      method: "PUT",
      body: JSON.stringify({ employeeId: niaId, column: "preparacion", level: "bien" }),
    }));
    expect(badLevel.status).toBe(400);
    expect(await prisma.boardChangeLog.count({ where: { managerId: ownerId } })).toBe(logsBefore);
    expect(await prisma.employeeStationAbility.findMany({
      where: { employeeId: niaId, stationId: { in: ["pdf_pr1e", "pdf_pr2e", "pdf_pr3e"] } },
      orderBy: { stationId: "asc" },
    })).toEqual(before);

    const saved = await saveAbility(authed(ownerToken, putUrl, {
      method: "PUT",
      body: JSON.stringify({ employeeId: niaId, column: "preparacion", level: "training" }),
    }));
    expect(saved.status).toBe(200);
    const family = await prisma.employeeStationAbility.findMany({
      where: { employeeId: niaId, stationId: { in: ["pdf_pr1e", "pdf_pr2e", "pdf_pr3e"] } },
      orderBy: { stationId: "asc" },
    });
    expect(family.map((row) => row.level)).toEqual(["training", "training", "training"]);

    const spy = vi.spyOn(boardChangeLog, "writeBoardChange").mockRejectedValue(new Error("log failed"));
    try {
      const failed = await saveAbility(authed(ownerToken, putUrl, {
        method: "PUT",
        body: JSON.stringify({ employeeId: niaId, column: "preparacion", level: "preferred" }),
      }));
      expect(failed.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const afterFail = await prisma.employeeStationAbility.findMany({
      where: { employeeId: niaId, stationId: { in: ["pdf_pr1e", "pdf_pr2e", "pdf_pr3e"] } },
      orderBy: { stationId: "asc" },
    });
    expect(afterFail.map((row) => row.level)).toEqual(["training", "training", "training"]);
    const failedLogs = await prisma.boardChangeLog.findMany({
      where: { managerId: ownerId, summary: { contains: "preferred" } },
    });
    expect(failedLogs).toEqual([]);
  });

  it("B3 the change log row names the owner and carries no level word", async () => {
    const rows = await prisma.boardChangeLog.findMany({
      where: { managerId: ownerId, route: BOARD_CHANGE_ROUTES.abilities },
      orderBy: { createdAt: "asc" },
    });
    const family = rows.find((row) => row.summary.includes("station=preparacion"));
    expect(family).toBeTruthy();
    expect(family).toMatchObject({
      managerId: ownerId,
      managerName: ownerName,
      route: "PUT /api/admin/abilities",
      date: "undated",
      summary: "undated station=preparacion count=3",
    });
    expect(family!.summary).not.toMatch(LEVEL_WORD);
    expect(rows.filter((row) => row.summary.includes("station=preparacion"))).toHaveLength(1);
  });

  it("B4 staff and manager responses omit abilities, including a name-only write", async () => {
    const today = chicagoToday();
    const startAt = chicagoDateTime(today, "9:00 am");
    const endAt = chicagoDateTime(today, "5:00 pm");
    await prisma.shift.create({
      data: {
        employeeId: niaId,
        date: today,
        startAt,
        endAt,
        sourcePosition: "Cocina",
        board: "cocina",
      },
    });
    const dayUrl = `http://local/api/boards/cocina/days/${today}`;
    const dayContext = { params: Promise.resolve({ board: "cocina", date: today }) };

    const staff = await dayBoard(authed(null, dayUrl), dayContext);
    expect(staff.status).toBe(200);
    const staffBody = await staff.json();
    for (const shift of staffBody.shifts) expect(shift.employee).not.toHaveProperty("abilities");

    const managerDay = await dayBoard(authed(managerToken, dayUrl), dayContext);
    expect(managerDay.status).toBe(200);
    const managerBody = await managerDay.json();
    const managerNia = managerBody.shifts.find((shift: { employee: { id: string } }) => shift.employee.id === niaId);
    expect(managerNia.employee).not.toHaveProperty("abilities");

    const ownerDay = await dayBoard(authed(ownerToken, dayUrl), dayContext);
    const ownerBody = await ownerDay.json();
    const ownerNia = ownerBody.shifts.find((shift: { employee: { id: string } }) => shift.employee.id === niaId);
    expect(ownerNia.employee.abilities.length).toBeGreaterThan(0);

    expect((await listEmployees(authed(null, "http://local/api/employees"))).status).toBe(401);
    expect((await getEmployee(authed(null, `http://local/api/employees/${niaId}`), { params: Promise.resolve({ id: niaId }) })).status).toBe(401);

    const managerList = await listEmployees(authed(managerToken, "http://local/api/employees"));
    expect(managerList.status).toBe(200);
    const listed = (await managerList.json()).employees.find((row: { id: string }) => row.id === niaId);
    expect(listed).not.toHaveProperty("abilities");

    const ownerList = await listEmployees(authed(ownerToken, "http://local/api/employees"));
    const ownerListed = (await ownerList.json()).employees.find((row: { id: string }) => row.id === niaId);
    expect(ownerListed.abilities.length).toBeGreaterThan(0);

    const managerOne = await getEmployee(
      authed(managerToken, `http://local/api/employees/${niaId}`),
      { params: Promise.resolve({ id: niaId }) },
    );
    expect((await managerOne.json()).employee).not.toHaveProperty("abilities");
    const ownerOne = await getEmployee(
      authed(ownerToken, `http://local/api/employees/${niaId}`),
      { params: Promise.resolve({ id: niaId }) },
    );
    expect((await ownerOne.json()).employee.abilities.length).toBeGreaterThan(0);

    const renamed = await patchEmployee(
      authed(managerToken, `http://local/api/employees/${beaId}`, {
        method: "PATCH",
        body: JSON.stringify({ firstName: "Bria" }),
      }),
      { params: Promise.resolve({ id: beaId }) },
    );
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json();
    expect(renamedBody.employee.firstName).toBe("Bria");
    expect(renamedBody.employee).not.toHaveProperty("abilities");

    const created = await createEmployee(authed(managerToken, "http://local/api/employees", {
      method: "POST",
      body: JSON.stringify({ firstName: "Ciro", lastName: "Sol", externalId: `${stamp}-ciro` }),
    }));
    expect(created.status).toBe(200);
    expect((await created.json()).employee).not.toHaveProperty("abilities");

    const ownerCreated = await createEmployee(authed(ownerToken, "http://local/api/employees", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Dara",
        lastName: "Sol",
        externalId: `${stamp}-dara`,
        abilities: [{ stationId: "pdf_guia", level: "ok" }],
      }),
    }));
    expect(ownerCreated.status).toBe(200);
    expect((await ownerCreated.json()).employee.abilities).toEqual([
      expect.objectContaining({ stationId: "pdf_guia", level: "ok" }),
    ]);
  });

  it("B5 a manager cannot write abilities or toggle a favorite", async () => {
    const before = await prisma.employee.findUniqueOrThrow({ where: { id: niaId } });
    const levelsBefore = await prisma.employeeStationAbility.findMany({ where: { employeeId: niaId } });
    const refused = await patchEmployee(
      authed(managerToken, `http://local/api/employees/${niaId}`, {
        method: "PATCH",
        body: JSON.stringify({
          firstName: "Changed",
          abilities: [{ stationId: "pdf_guia", level: "preferred" }],
        }),
      }),
      { params: Promise.resolve({ id: niaId }) },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Owner code required" });
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: niaId } });
    expect(after.firstName).toBe(before.firstName);
    expect(await prisma.employeeStationAbility.findMany({ where: { employeeId: niaId } })).toEqual(levelsBefore);

    const posted = await createEmployee(authed(managerToken, "http://local/api/employees", {
      method: "POST",
      body: JSON.stringify({
        firstName: "No",
        lastName: "Write",
        externalId: `${stamp}-blocked`,
        abilities: [{ stationId: "pdf_guia", level: "forbidden" }],
      }),
    }));
    expect(posted.status).toBe(403);
    expect(await prisma.employee.findUnique({ where: { externalId: `${stamp}-blocked` } })).toBeNull();

    const guia = await prisma.employeeStationAbility.findUniqueOrThrow({
      where: { employeeId_stationId: { employeeId: niaId, stationId: "pdf_guia" } },
    });
    const star = await favorite(authed(managerToken, "http://local/api/abilities/favorite", {
      method: "POST",
      body: JSON.stringify({ employeeId: niaId, stationId: "pdf_guia" }),
    }));
    expect(star.status).toBe(403);
    expect(await prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId: niaId, stationId: "pdf_guia" } },
    })).toMatchObject({ level: guia.level });

    const ownerStar = await favorite(authed(ownerToken, "http://local/api/abilities/favorite", {
      method: "POST",
      body: JSON.stringify({ employeeId: beaId, stationId: "pdf_guia" }),
    }));
    expect(ownerStar.status).toBe(200);
    expect(await ownerStar.json()).toEqual({ level: "preferred" });
  });

  it("B6 a manager still cannot assign a forbidden person, and a missing row is allowed", async () => {
    const shift = await prisma.shift.findFirstOrThrow({
      where: { employeeId: niaId, date: future, board: "cocina" },
    });
    await prisma.employeeStationAbility.upsert({
      where: { employeeId_stationId: { employeeId: niaId, stationId: "pdf_guia" } },
      create: { employeeId: niaId, stationId: "pdf_guia", level: "forbidden" },
      update: { level: "forbidden" },
    });
    const refused = await assignHour(authed(managerToken, "http://local/api/assignments", {
      method: "PUT",
      body: JSON.stringify({ shiftId: shift.id, stationId: "pdf_guia", date: future, hour: 10 }),
    }));
    expect(refused.status).toBe(422);
    expect(await prisma.assignment.count({ where: { shiftId: shift.id } })).toBe(0);

    const open = await prisma.shift.findFirstOrThrow({ where: { employeeId: beaId, date: future } });
    const openStation = "pdf_pstl";
    expect(await prisma.employeeStationAbility.findUnique({
      where: { employeeId_stationId: { employeeId: beaId, stationId: openStation } },
    })).toBeNull();
    const allowed = await assignHour(authed(managerToken, "http://local/api/assignments", {
      method: "PUT",
      body: JSON.stringify({ shiftId: open.id, stationId: openStation, date: future, hour: 11 }),
    }));
    expect(allowed.status).toBe(200);
    expect(await prisma.assignment.count({ where: { shiftId: open.id, stationId: openStation } })).toBe(1);
  });

  it("B6 a forbidden assignment already on the board warns a manager and a staff tablet", async () => {
    const today = chicagoToday();
    const shift = await prisma.shift.findFirstOrThrow({
      where: { employeeId: niaId, date: today, board: "cocina" },
    });
    let placedId = "";
    for (const hour of [10, 12, 13, 14, 15]) {
      const hourStart = chicagoHourStart(today, hour);
      const taken = await prisma.assignment.findFirst({
        where: {
          OR: [
            { employeeId: niaId, hourStart },
            { stationId: "pdf_guia", hourStart },
          ],
        },
      });
      if (taken) continue;
      const placed = await prisma.assignment.create({
        data: {
          shiftId: shift.id,
          employeeId: niaId,
          stationId: "pdf_guia",
          hourStart,
          hourEnd: chicagoHourEnd(today, hour),
        },
      });
      placedId = placed.id;
      break;
    }
    expect(placedId).not.toBe("");

    const dayUrl = `http://local/api/boards/cocina/days/${today}`;
    const dayContext = { params: Promise.resolve({ board: "cocina", date: today }) };
    const staff = await dayBoard(authed(null, dayUrl), dayContext);
    const managerDay = await dayBoard(authed(managerToken, dayUrl), dayContext);
    const ownerDay = await dayBoard(authed(ownerToken, dayUrl), dayContext);
    expect(staff.status).toBe(200);
    expect(managerDay.status).toBe(200);
    const staffBody = await staff.json();
    const managerBody = await managerDay.json();
    const ownerBody = await ownerDay.json();

    function placedAssignment(body: {
      shifts: { employee: { id: string; abilities?: unknown }; assignments: { id: string; abilityBlocked?: boolean }[] }[];
    }) {
      const row = body.shifts.find((item) => item.employee.id === niaId);
      return {
        employee: row?.employee,
        assignment: row?.assignments.find((item) => item.id === placedId),
      };
    }

    for (const body of [staffBody, managerBody]) {
      const { employee, assignment } = placedAssignment(body);
      expect(employee).not.toHaveProperty("abilities");
      expect(assignment?.abilityBlocked).toBe(true);
      expect(assignment).not.toHaveProperty("level");
    }
    const ownerPlaced = placedAssignment(ownerBody);
    expect(ownerPlaced.employee?.abilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ stationId: "pdf_guia", level: "forbidden" })]),
    );
    expect(ownerPlaced.assignment?.abilityBlocked).toBe(true);

    const ownerHit = findBoardViolations(ownerBody).find(
      (row) => row.assignmentId === placedId && row.code === "FORBIDDEN_ABILITY",
    );
    const staffHit = findBoardViolations(staffBody).find(
      (row) => row.assignmentId === placedId && row.code === "FORBIDDEN_ABILITY",
    );
    const managerHit = findBoardViolations(managerBody).find(
      (row) => row.assignmentId === placedId && row.code === "FORBIDDEN_ABILITY",
    );
    expect(ownerHit?.message).toBe("Employee is forbidden from station pdf_guia");
    expect(staffHit?.message).toBe(ownerHit?.message);
    expect(managerHit?.message).toBe(ownerHit?.message);
  });

  it("the tap cycle and a mixed family open on bien", () => {
    expect(nextStoredLevel("forbidden")).toBe("training");
    expect(nextStoredLevel("training")).toBe("ok");
    expect(nextStoredLevel("ok")).toBe("preferred");
    expect(nextStoredLevel("preferred")).toBe("forbidden");
    expect(nextStoredLevel("mixed")).toBe("ok");
  });
});
