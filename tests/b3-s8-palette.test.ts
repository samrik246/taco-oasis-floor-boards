/**
 * B3 S8: palette order from mandatory stations, then saved 28-day use.
 */
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GET as dayBoard } from "@/app/api/boards/[board]/days/[date]/route";
import { paletteStationIds, paletteUseStart, PALETTE_USE_DAYS } from "@/lib/assignments/palette-order";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import { isDefaultMandatory } from "@/lib/mandatory";
import { addDays } from "@/lib/upcoming/calendar";
import { CAJA_STATIONS, COCINA_STATIONS } from "@/lib/stations";

const prisma = new PrismaClient();
const stamp = `b3s8-${Date.now()}`;
const shown = "2099-03-01";
const windowStart = paletteUseStart(shown);
const inWindow = "2099-02-15";
const beforeWindow = addDays(windowStart, -1);

let managerId = "";

function authed(token: string, url: string) {
  const headers = new Headers();
  headers.set("x-manager-session", token);
  return new Request(url, { headers });
}

async function day(token: string, board: string, date: string) {
  const response = await dayBoard(
    authed(token, `http://local/api/boards/${board}/days/${date}`),
    { params: Promise.resolve({ board, date }) },
  );
  return { status: response.status, body: await response.json() };
}

function countOf(rows: { stationId: string; count: number }[], stationId: string): number {
  const hits = rows.filter((row) => row.stationId === stationId);
  expect(hits).toHaveLength(1);
  return hits[0]!.count;
}

describe("B3 S8 palette order", () => {
  it("puts default-mandatory stations first, then today's marks, then use", () => {
    const ids = ["pdf_tf1r", "pdf_pr1e", "pdf_tq1r", "pdf_pstl", "pdf_br1a", "pdf_crne", "pdf_br2a", "pdf_tq2r"];
    const stations = COCINA_STATIONS.filter((station) => ids.includes(station.id));
    const stationUse = [
      { stationId: "pdf_br1a", count: 50 },
      { stationId: "pdf_br2a", count: 4 },
      { stationId: "pdf_crne", count: 4 },
      { stationId: "pdf_tq2r", count: 1 },
      { stationId: "pdf_pstl", count: 100 },
      { stationId: "pdf_tf1r", count: 1 },
    ];
    const extraStationIds = ["pdf_pstl", "pdf_tf1r"];
    const order = paletteStationIds({ stations, stationUse, extraStationIds });
    expect(order).toEqual([
      "pdf_tf1r",
      "pdf_pr1e",
      "pdf_tq1r",
      "pdf_pstl",
      "pdf_br1a",
      "pdf_br2a",
      "pdf_crne",
      "pdf_tq2r",
    ]);
    expect(order.filter((id) => id === "pdf_tf1r")).toEqual(["pdf_tf1r"]);
  });

  it("breaks a use tie by board order, and caja has no mandatory set", () => {
    const stationUse = [
      { stationId: "green1", count: 4 },
      { stationId: "yellow", count: 4 },
      { stationId: "yellow2", count: 4 },
      { stationId: "mana", count: 0 },
    ];
    const order = paletteStationIds({ stations: CAJA_STATIONS, stationUse });
    expect(order.slice(0, 4)).toEqual(["green1", "yellow", "yellow2", "mana"]);
    expect(order[0]).not.toBe("mana");
    expect(order.filter((id) => isDefaultMandatory(id))).toEqual([]);
    expect(order.filter((id) => id === "yellow")).toEqual(["yellow"]);
  });

  it("keeps the same order when a draft is not part of the saved counts", () => {
    const stations = COCINA_STATIONS;
    const stationUse = [{ stationId: "pdf_br1a", count: 3 }];
    const before = paletteStationIds({
      stations,
      stationUse,
      extraStationIds: ["pdf_pstl"],
    });
    const draftCells = [{ stationId: "pdf_tq2r", count: 999 }];
    expect(draftCells[0]?.count).toBe(999);
    expect(paletteStationIds({
      stations,
      stationUse,
      extraStationIds: ["pdf_pstl"],
    })).toEqual(before);
    const saved = paletteStationIds({
      stations,
      stationUse: [...stationUse, { stationId: "pdf_tq2r", count: 999 }],
      extraStationIds: ["pdf_pstl"],
    });
    expect(saved.indexOf("pdf_tq2r")).toBeLessThan(saved.indexOf("pdf_br1a"));
    expect(before.indexOf("pdf_br1a")).toBeLessThan(before.indexOf("pdf_tq2r"));
  });

  it("covers the 28 calendar days before the day shown and not that day", () => {
    expect(PALETTE_USE_DAYS).toBe(28);
    expect(paletteUseStart("2026-09-28")).toBe("2026-08-31");
    expect(windowStart).toBe("2099-02-01");
    expect(beforeWindow).toBe("2099-01-31");
    let cursor = windowStart;
    let days = 0;
    while (cursor < shown) {
      days += 1;
      cursor = addDays(cursor, 1);
    }
    expect(days).toBe(28);
  });
});

describe("B3 S8 station use counts", () => {
  let token = "";

  afterAll(async () => {
    const people = await prisma.employee.findMany({
      where: { externalId: { startsWith: stamp } },
      select: { id: true },
    });
    const ids = people.map((person) => person.id);
    if (ids.length > 0) {
      await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employeeStationAbility.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
    }
    if (managerId) await prisma.manager.deleteMany({ where: { id: managerId } });
    await prisma.$disconnect();
  });

  it("counts saved rows in the window for that board, and the payload has no names or levels", async () => {
    const manager = await prisma.manager.create({
      data: { name: `${stamp} Manager`, codeHash: hashManagerCode(`${stamp}-code`), role: "manager" },
    });
    managerId = manager.id;
    token = signManagerSession({ id: manager.id, name: manager.name });
    const person = await prisma.employee.create({
      data: { externalId: `${stamp}-person`, firstName: "S8SecretName", lastName: "Moss" },
    });
    await prisma.employeeStationAbility.create({
      data: { employeeId: person.id, stationId: "pdf_guia", level: "forbidden" },
    });

    async function shiftOn(date: string, board: "caja" | "cocina") {
      return prisma.shift.create({
        data: {
          employeeId: person.id,
          date,
          startAt: chicagoHourStart(date, 8),
          endAt: chicagoHourStart(date, 17),
          sourcePosition: board === "caja" ? "Caja" : "Cocina",
          board,
        },
      });
    }

    async function paint(shiftId: string, stationId: string, date: string, hour: number) {
      await prisma.assignment.create({
        data: {
          shiftId,
          employeeId: person.id,
          stationId,
          hourStart: chicagoHourStart(date, hour),
          hourEnd: chicagoHourEnd(date, hour),
        },
      });
    }

    const startShift = await shiftOn(windowStart, "cocina");
    const midShift = await shiftOn(inWindow, "cocina");
    const oldShift = await shiftOn(beforeWindow, "cocina");
    const todayShift = await shiftOn(shown, "cocina");
    const cajaShift = await shiftOn(inWindow, "caja");
    await paint(startShift.id, "pdf_guia", windowStart, 8);
    await paint(midShift.id, "pdf_guia", inWindow, 10);
    await paint(midShift.id, "pdf_guia", inWindow, 11);
    await paint(midShift.id, "pdf_crne", inWindow, 12);
    await paint(oldShift.id, "pdf_guia", beforeWindow, 8);
    await paint(todayShift.id, "pdf_guia", shown, 8);
    await paint(cajaShift.id, "green1", inWindow, 8);
    await paint(cajaShift.id, "pdf_guia", inWindow, 14);

    const cocina = await day(token, "cocina", shown);
    const caja = await day(token, "caja", shown);
    expect(cocina.status).toBe(200);
    expect(caja.status).toBe(200);

    for (const row of cocina.body.stationUse as { stationId: string; count: number }[]) {
      expect(Object.keys(row).sort()).toEqual(["count", "stationId"]);
      expect(typeof row.count).toBe("number");
    }
    const useJson = JSON.stringify(cocina.body.stationUse);
    expect(useJson).not.toContain("S8SecretName");
    expect(useJson).not.toContain("forbidden");
    expect(useJson).not.toContain("Moss");
    expect(cocina.body.stationUse).toHaveLength(cocina.body.stations.length);
    expect(countOf(cocina.body.stationUse, "pdf_guia")).toBe(3);
    expect(countOf(cocina.body.stationUse, "pdf_crne")).toBe(1);
    expect(countOf(cocina.body.stationUse, "pdf_tq1r")).toBe(0);
    expect(countOf(caja.body.stationUse, "green1")).toBe(1);
    expect(caja.body.stationUse.some((row: { stationId: string }) => row.stationId === "pdf_guia")).toBe(false);
  });
});
