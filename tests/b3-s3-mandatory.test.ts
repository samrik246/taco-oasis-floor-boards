/**
 * B3 S3: standing mandatory stations, one-day owner marks, and gap hours from 11.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PUT as saveMandatory } from "@/app/api/admin/mandatory/route";
import { GET as dayBoard } from "@/app/api/boards/[board]/days/[date]/route";
import { BOARD_CHANGE_ROUTES } from "@/lib/board-change-log";
import * as boardChangeLog from "@/lib/board-change-log";
import { hashManagerCode } from "@/lib/managers/codes";
import { signManagerSession } from "@/lib/managers/session";
import {
  MANDATORY_STATIONS,
  mandatoryGapLabel,
  uncoveredMandatory,
} from "@/lib/mandatory";
import { chicagoHourStart } from "@/lib/hour-grid";
import { chicagoToday } from "@/lib/upcoming/source";
import { readLastBoard, saveLastBoard } from "@/lib/offline-board";

const prisma = new PrismaClient();
const stamp = `b3s3-${Date.now()}`;
const markDate = "2034-07-02";
const nextDate = "2034-07-03";

let ownerToken = "";
let managerToken = "";
let otherToken = "";
let ownerId = "";
let ownerName = "";

function authed(token: string | null, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (token) headers.set("x-manager-session", token);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Request(url, { ...init, headers });
}

function put(token: string | null, body: unknown) {
  return saveMandatory(authed(token, "http://local/api/admin/mandatory", {
    method: "PUT",
    body: JSON.stringify(body),
  }));
}

async function day(token: string | null, board: string, date: string) {
  const response = await dayBoard(
    authed(token, `http://local/api/boards/${board}/days/${date}`),
    { params: Promise.resolve({ board, date }) },
  );
  return { status: response.status, body: await response.json() };
}

describe("B3 S3 mandatory gap helper", () => {
  const hours = [7, 8, 9, 10, 11, 12, 21];
  const start = chicagoHourStart(markDate, 9).toISOString();
  const end = chicagoHourStart(markDate, 17).toISOString();
  const shift = {
    id: "lea",
    date: markDate,
    startAt: start,
    endAt: end,
    assignments: [] as { stationId: string; hourStart: string }[],
  };

  it("C5 an empty station at 10 is not a gap, an empty station at 11 is, and a draft fills only that station", () => {
    const open = uncoveredMandatory({
      stationIds: MANDATORY_STATIONS,
      hours,
      date: markDate,
      shifts: [shift],
    });
    expect(open.some((gap) => gap.stationId === "pdf_tq1r" && gap.hour === 10)).toBe(false);
    expect(open.some((gap) => gap.stationId === "pdf_tq1r" && gap.hour === 11)).toBe(true);
    expect(open.some((gap) => gap.hour < 11)).toBe(false);

    const filled = uncoveredMandatory({
      stationIds: MANDATORY_STATIONS,
      hours,
      date: markDate,
      shifts: [shift],
      drafts: [{ shiftId: "lea", hour: 11, stationId: "pdf_tq1r" }],
    });
    expect(filled.some((gap) => gap.stationId === "pdf_tq1r" && gap.hour === 11)).toBe(false);
    expect(filled.some((gap) => gap.stationId === "pdf_tf1r" && gap.hour === 11)).toBe(true);

    const otherSeat = uncoveredMandatory({
      stationIds: ["pdf_tq1r"],
      hours,
      date: markDate,
      shifts: [{
        ...shift,
        assignments: [{ stationId: "pdf_tq2r", hourStart: chicagoHourStart(markDate, 11).toISOString() }],
      }],
    });
    expect(otherSeat).toEqual(expect.arrayContaining([{ stationId: "pdf_tq1r", hour: 11 }]));
    expect(mandatoryGapLabel({ shortCode: "TQ1R", label: "Taquero 1 + Relleno" })).toBe("TQ1R");
    expect(mandatoryGapLabel({ shortCode: "  ", label: "Taquero 1 + Relleno" })).toBe("Taquero 1 + Relleno");
  });

  it("an empty caja hour from 11 is a gap, an earlier hour is not, and the second seat does not cover the first", () => {
    const cajaIds = ["green1", "purple1", "yellow", "nieves"] as const;
    const open = uncoveredMandatory({
      stationIds: cajaIds,
      hours,
      date: markDate,
      shifts: [shift],
    });
    expect(open.some((gap) => gap.hour < 11)).toBe(false);
    expect(open.some((gap) => gap.stationId === "yellow" && gap.hour === 10)).toBe(false);
    expect(open.filter((gap) => gap.hour === 11).map((gap) => gap.stationId)).toEqual([...cajaIds]);

    const coveredBySeconds = uncoveredMandatory({
      stationIds: cajaIds,
      hours,
      date: markDate,
      shifts: [
        {
          ...shift,
          id: "yellow-two",
          assignments: [{ stationId: "yellow2", hourStart: chicagoHourStart(markDate, 11).toISOString() }],
        },
        {
          ...shift,
          id: "purple-two",
          assignments: [{ stationId: "purple2", hourStart: chicagoHourStart(markDate, 11).toISOString() }],
        },
        {
          ...shift,
          id: "nieves-two",
          assignments: [{ stationId: "nieves2", hourStart: chicagoHourStart(markDate, 11).toISOString() }],
        },
      ],
    });
    for (const stationId of ["yellow", "purple1", "nieves", "green1"]) {
      expect(coveredBySeconds.some((gap) => gap.stationId === stationId && gap.hour === 11)).toBe(true);
    }
  });
});

describe("B3 S3 mandatory marks", () => {
  afterAll(async () => {
    if (ownerId) {
      await prisma.mandatoryMark.deleteMany({ where: { managerId: ownerId } });
      await prisma.boardChangeLog.deleteMany({ where: { managerId: ownerId } });
    }
    await prisma.manager.deleteMany({ where: { name: { startsWith: stamp } } });
    await prisma.$disconnect();
  });

  it("C1 PUT is 401, 403, then 200, and a bad station or date writes nothing", async () => {
    const owner = await prisma.manager.create({
      data: { name: `${stamp} Owner`, codeHash: hashManagerCode(`${stamp}-owner`), role: "owner" },
    });
    const manager = await prisma.manager.create({
      data: { name: `${stamp} Manager`, codeHash: hashManagerCode(`${stamp}-manager`), role: "manager" },
    });
    const other = await prisma.manager.create({
      data: { name: `${stamp} Lead`, codeHash: hashManagerCode(`${stamp}-lead`), role: "lead" },
    });
    ownerId = owner.id;
    ownerName = owner.name;
    ownerToken = signManagerSession({ id: owner.id, name: owner.name });
    managerToken = signManagerSession({ id: manager.id, name: manager.name });
    otherToken = signManagerSession({ id: other.id, name: other.name });

    const marksBefore = await prisma.mandatoryMark.count();
    const logsBefore = await prisma.boardChangeLog.count({ where: { managerId: ownerId } });

    expect((await put(null, { date: markDate, stationId: "pdf_pstl", on: true })).status).toBe(401);
    expect((await put(managerToken, { date: markDate, stationId: "pdf_pstl", on: true })).status).toBe(403);
    expect((await put(otherToken, { date: markDate, stationId: "pdf_pstl", on: true })).status).toBe(403);

    for (const body of [
      { date: markDate, stationId: "pdf_tq1r", on: true },
      { date: markDate, stationId: "green1", on: true },
      { date: markDate, stationId: "not-a-station", on: true },
      { date: "2034-02-31", stationId: "pdf_pstl", on: true },
      { date: "tomorrow", stationId: "pdf_pstl", on: true },
    ]) {
      expect((await put(ownerToken, body)).status).toBe(400);
    }

    expect(await prisma.mandatoryMark.count()).toBe(marksBefore);
    expect(await prisma.boardChangeLog.count({ where: { managerId: ownerId } })).toBe(logsBefore);

    const saved = await put(ownerToken, { date: markDate, stationId: "pdf_pstl", on: true });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ changed: true });
  });

  it("C2 on and off share one transaction with the log, and a repeat writes nothing", async () => {
    const onRow = await prisma.mandatoryMark.findUnique({
      where: { board_date_stationId: { board: "cocina", date: markDate, stationId: "pdf_pstl" } },
    });
    expect(onRow?.managerId).toBe(ownerId);
    const onLogs = await prisma.boardChangeLog.findMany({
      where: { managerId: ownerId, route: BOARD_CHANGE_ROUTES.mandatory },
    });
    expect(onLogs).toHaveLength(1);
    expect(onLogs[0]).toMatchObject({
      managerId: ownerId,
      managerName: ownerName,
      route: "PUT /api/admin/mandatory",
      date: markDate,
      summary: `${markDate} station=pdf_pstl on`,
    });

    const repeat = await put(ownerToken, { date: markDate, stationId: "pdf_pstl", on: true });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ changed: false });
    expect(await prisma.boardChangeLog.count({
      where: { managerId: ownerId, route: BOARD_CHANGE_ROUTES.mandatory },
    })).toBe(1);

    const cleared = await put(ownerToken, { date: markDate, stationId: "pdf_pstl", on: false });
    expect(cleared.status).toBe(200);
    expect(await prisma.mandatoryMark.findUnique({
      where: { board_date_stationId: { board: "cocina", date: markDate, stationId: "pdf_pstl" } },
    })).toBeNull();
    const offLogs = await prisma.boardChangeLog.findMany({
      where: { managerId: ownerId, route: BOARD_CHANGE_ROUTES.mandatory },
      orderBy: { createdAt: "asc" },
    });
    expect(offLogs.map((row) => row.summary)).toEqual([
      `${markDate} station=pdf_pstl on`,
      `${markDate} station=pdf_pstl off`,
    ]);

    const repeatOff = await put(ownerToken, { date: markDate, stationId: "pdf_pstl", on: false });
    expect(repeatOff.status).toBe(200);
    expect(await repeatOff.json()).toEqual({ changed: false });
    expect(await prisma.boardChangeLog.count({
      where: { managerId: ownerId, route: BOARD_CHANGE_ROUTES.mandatory },
    })).toBe(2);

    const spy = vi.spyOn(boardChangeLog, "writeBoardChange").mockRejectedValue(new Error("log failed"));
    try {
      const failed = await put(ownerToken, { date: markDate, stationId: "pdf_br2a", on: true });
      expect(failed.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.mandatoryMark.findUnique({
      where: { board_date_stationId: { board: "cocina", date: markDate, stationId: "pdf_br2a" } },
    })).toBeNull();
    expect(await prisma.boardChangeLog.count({
      where: { managerId: ownerId, summary: { contains: "pdf_br2a" } },
    })).toBe(0);
  });

  it("C3 a mark stays on its date, and the three are present every day", async () => {
    expect((await put(ownerToken, { date: markDate, stationId: "pdf_pstl", on: true })).status).toBe(200);
    const marked = await day(ownerToken, "cocina", markDate);
    const next = await day(ownerToken, "cocina", nextDate);
    expect(marked.body.mandatory.stationIds).toEqual([...MANDATORY_STATIONS, "pdf_pstl"]);
    expect(marked.body.mandatory.extraStationIds).toEqual(["pdf_pstl"]);
    expect(next.body.mandatory.stationIds).toEqual([...MANDATORY_STATIONS]);
    expect(next.body.mandatory.extraStationIds).toEqual([]);
    expect(next.body.mandatory.stationIds).not.toContain("pdf_pstl");
  });

  it("C4 staff have no mandatory key, and a manager sees the standing set on both boards", async () => {
    const today = chicagoToday();
    const staff = await day(null, "cocina", today);
    expect(staff.status).toBe(200);
    expect(staff.body).not.toHaveProperty("mandatory");

    const cajaStaff = await day(null, "caja", today);
    expect(cajaStaff.status).toBe(200);
    expect(cajaStaff.body).not.toHaveProperty("mandatory");

    const manager = await day(managerToken, "cocina", today);
    expect(manager.body.mandatory).toMatchObject({
      stationIds: [...MANDATORY_STATIONS],
      extraStationIds: [],
      canMark: false,
    });

    const owner = await day(ownerToken, "cocina", today);
    expect(owner.body.mandatory.canMark).toBe(true);
    expect(owner.body.mandatory.stationIds).toEqual([...MANDATORY_STATIONS]);

    const caja = await day(managerToken, "caja", today);
    expect(caja.status).toBe(200);
    expect(caja.body.mandatory).toEqual({
      stationIds: ["green1", "purple1", "yellow", "nieves"],
      extraStationIds: [],
      canMark: false,
    });
  });

  it("an owner marks an extra caja station for one day and cannot clear a default", async () => {
    for (const stationId of ["green1", "purple1", "yellow", "nieves"]) {
      expect((await put(ownerToken, { date: markDate, stationId, on: false })).status).toBe(400);
    }

    const cocinaBefore = await day(ownerToken, "cocina", markDate);
    expect(cocinaBefore.body.mandatory.stationIds).toEqual([...MANDATORY_STATIONS, "pdf_pstl"]);

    const on = await put(ownerToken, { date: markDate, stationId: "green2", on: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ changed: true });
    const marked = await day(ownerToken, "caja", markDate);
    expect(marked.body.mandatory.stationIds).toEqual([
      "green1", "purple1", "yellow", "nieves", "green2",
    ]);
    expect(marked.body.mandatory.extraStationIds).toEqual(["green2"]);
    expect(marked.body.mandatory.canMark).toBe(true);

    const next = await day(ownerToken, "caja", nextDate);
    expect(next.body.mandatory.stationIds).toEqual(["green1", "purple1", "yellow", "nieves"]);
    expect(next.body.mandatory.extraStationIds).toEqual([]);

    const off = await put(ownerToken, { date: markDate, stationId: "green2", on: false });
    expect(off.status).toBe(200);
    const cleared = await day(ownerToken, "caja", markDate);
    expect(cleared.body.mandatory.extraStationIds).toEqual([]);
    expect(cleared.body.mandatory.stationIds).toEqual(["green1", "purple1", "yellow", "nieves"]);

    const cocinaAfter = await day(ownerToken, "cocina", markDate);
    expect(cocinaAfter.body.mandatory).toEqual(cocinaBefore.body.mandatory);
  });
});

describe("B3 S3 shared tablet cache", () => {
  const store = new Map<string, string>();
  const now = new Date("2026-09-26T18:00:00Z");
  const todayYmd = "2026-09-26";

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("drops mandatory on write and rewrites a snapshot that still has it", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    };
    const day = {
      date: todayYmd,
      stations: [],
      shifts: [],
      mandatory: { stationIds: ["pdf_tq1r"], extraStationIds: [], canMark: true },
    };
    saveLastBoard({ board: "cocina", date: todayYmd, day }, now);
    expect(day).toHaveProperty("mandatory");
    const raw = store.get("taco-oasis-last-board-v1") ?? "";
    expect(raw).not.toContain('"mandatory"');
    store.set("taco-oasis-last-board-v1", JSON.stringify({
      version: 1,
      board: "cocina",
      date: todayYmd,
      day,
      savedAt: now.toISOString(),
    }));
    expect(JSON.stringify(readLastBoard(now)?.day)).not.toContain('"mandatory"');
    expect(store.get("taco-oasis-last-board-v1")).not.toContain('"mandatory"');
  });
});
