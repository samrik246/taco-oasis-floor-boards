import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { POST } from "@/app/api/boards/[board]/days/[date]/overlays/route";
import { listBreakCovers } from "@/lib/breaks/covers";
import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { loadOverlayRecords, screenOverlays } from "@/lib/overlays/read";
import { cancelOverlay, endImportedOverlays, saveOverlay } from "@/lib/overlays/write";
import type { SliceOverlay, SliceShift } from "@/lib/slices/day-slices";
import { chicagoDateTime } from "@/lib/time";
import { chicagoToday } from "@/lib/upcoming/source";

const prisma = new PrismaClient();
const date = "2036-06-16";
const now = chicagoDateTime(date, "1:00 pm");
const stamp = `b4pr4-${Date.now()}`;
const manager = { id: `${stamp}-mgr`, name: "Gerente" };

function at(clock: string, day = date): Date {
  return chicagoDateTime(day, clock);
}

async function person(key: string, stationId: string | null, level?: string) {
  const employee = await prisma.employee.create({
    data: { externalId: `${stamp}-${key}`, firstName: key, lastName: "Moss" },
  });
  const shift = await prisma.shift.create({
    data: {
      employeeId: employee.id,
      date,
      board: "caja",
      sourcePosition: "Caja",
      startAt: at("11:00 am"),
      endAt: at("4:00 pm"),
    },
  });
  if (stationId) {
    await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId: employee.id,
        stationId,
        hourStart: at("1:00 pm"),
        hourEnd: at("2:00 pm"),
      },
    });
  }
  if (level) {
    await prisma.employeeStationAbility.create({
      data: { employeeId: employee.id, stationId: "green1", level },
    });
  }
  return employee;
}

describe("B4 PR 4 manager menu", () => {
  it("refuses the menu route on a day that is not today", async () => {
    const future = "2099-01-02";
    expect(future).not.toBe(chicagoToday());
    const response = await POST(new Request("http://floor.test/overlays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }), { params: Promise.resolve({ board: "caja", date: future }) });
    expect(response.status).toBe(404);
  });

  it("keeps paint, refuses an unfit partner, hides a cancel, names a star cover, and keeps an import end", async () => {
    for (const station of [
      { id: "green1", label: "Green 1", color: "green", sortOrder: 1 },
      { id: "paint-pr4-side", label: "Side", color: "blue", sortOrder: 80 },
      { id: "paint-pr4-extra", label: "Extra", color: "gray", sortOrder: 81 },
    ]) {
      await prisma.station.upsert({
        where: { id: station.id },
        create: { id: station.id, board: "caja", label: station.label, color: station.color, maxConcurrent: 1, sortOrder: station.sortOrder },
        update: { board: "caja" },
      });
    }
    const ada = await person("Ada", "green1");
    const bea = await person("Bea", "paint-pr4-side", "forbidden");
    const cam = await person("Cam", "paint-pr4-extra");
    const window = { startAt: at("1:00 pm"), endAt: at("1:15 pm") };
    const before = await prisma.assignment.count({ where: { employeeId: { in: [ada.id, bea.id, cam.id] } } });

    await expect(saveOverlay({
      manager,
      board: "caja",
      date,
      kind: "switch",
      employeeId: ada.id,
      partnerEmployeeId: bea.id,
      window: "quarters",
      ...window,
      now,
    })).rejects.toMatchObject({ code: "UNFIT" });
    expect(await prisma.assignment.count({ where: { employeeId: { in: [ada.id, bea.id, cam.id] } } })).toBe(before);

    const removed = await saveOverlay({
      manager,
      board: "caja",
      date,
      kind: "remove",
      employeeId: ada.id,
      window: "quarters",
      ...window,
      now,
    });
    expect(await prisma.assignment.count({ where: { employeeId: ada.id } })).toBe(1);
    expect(screenOverlays(await loadOverlayRecords(prisma, "caja", date), now).some((row) => row.id === removed.id)).toBe(true);
    await cancelOverlay({ manager, board: "caja", date, id: removed.id, now });
    const cancelled = (await loadOverlayRecords(prisma, "caja", date)).find((row) => row.id === removed.id);
    expect(cancelled?.endReason).toBe("cancel");
    expect(screenOverlays(await loadOverlayRecords(prisma, "caja", date), now).some((row) => row.id === removed.id)).toBe(false);

    const adaShift = await prisma.shift.findFirstOrThrow({ where: { employeeId: ada.id, date } });
    await prisma.staffBreak.create({
      data: {
        employeeId: ada.id,
        shiftId: adaShift.id,
        board: "caja",
        date,
        startAt: window.startAt,
        endAt: window.endAt,
        actor: "test",
        status: "pending",
      },
    });
    await saveOverlay({
      manager,
      board: "caja",
      date,
      kind: "switch",
      employeeId: ada.id,
      partnerEmployeeId: cam.id,
      window: "quarters",
      ...window,
      now,
    });
    const booked = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: ada.id, date } },
    });
    expect(booked.coverEmployeeId).toBe(cam.id);
    expect(booked.status).toBe("booked");
    expect(await prisma.assignment.count({ where: { employeeId: { in: [ada.id, bea.id, cam.id] } } })).toBe(before);

    const ended = await prisma.$transaction((tx) => endImportedOverlays(tx, {
      supersededShiftIds: [adaShift.id],
      boardRemovedShiftIds: [],
    }));
    expect(ended).toBe(1);
    const imported = await prisma.boardOverlay.findFirstOrThrow({
      where: { employeeId: ada.id, date, kind: "switch" },
    });
    expect(imported.endReason).toBe("import");
    expect(await prisma.boardOverlay.count({ where: { id: imported.id } })).toBe(1);
  });

  it("omits a person sitting another star from the cover list", () => {
    const stars = [...MANDATORY_STATIONS_BY_BOARD.cocina];
    const start = at("2:00 pm");
    const end = at("2:15 pm");
    const painted = stars.flatMap((stationId, index) => {
      if (index === 1) return [];
      return [{ id: `seat${index}`, stationId }];
    });
    const shifts: SliceShift[] = [...painted.map((row) => row.id), "bea", "cam"].map((id) => ({
      id,
      employeeId: id,
      board: "cocina",
      startAt: at("11:00 am"),
      endAt: at("4:00 pm"),
      superseded: false,
      boardRemoved: false,
    }));
    const overlay: SliceOverlay = {
      id: "seat-bea",
      kind: "add",
      employeeId: "bea",
      partnerEmployeeId: "bea",
      stationId: stars[1]!,
      startAt: at("11:00 am"),
      endAt: at("4:00 pm"),
    };
    const list = listBreakCovers({
      date,
      board: "cocina",
      employeeId: "seat0",
      startAt: start,
      endAt: end,
      shifts,
      paints: painted.map((row) => ({
        employeeId: row.id,
        shiftId: row.id,
        stationId: row.stationId,
        hourStart: at("2:00 pm"),
      })),
      breaks: [],
      overlays: [overlay],
      starStationIds: stars,
      abilities: [],
      names: new Map(shifts.map((shift) => [shift.employeeId, shift.employeeId])),
    });
    const simples = list.flatMap((row) => row.kind === "simple" ? [row.employeeId] : []);
    expect(simples).toContain("cam");
    expect(simples).not.toContain("bea");
  });
});
