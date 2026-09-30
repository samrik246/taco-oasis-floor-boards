import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { POST } from "@/app/api/boards/[board]/days/[date]/overlays/route";
import { listBreakCovers } from "@/lib/breaks/covers";
import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { loadOverlayRecords, screenOverlays } from "@/lib/overlays/read";
import { cancelOverlay, endImportedOverlays, saveOverlay } from "@/lib/overlays/write";
import { buildDaySlices, type SliceOverlay, type SliceShift } from "@/lib/slices/day-slices";
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

async function cajaStation(id: string) {
  await prisma.station.upsert({
    where: { id },
    create: { id, board: "caja", label: id, color: "gray", maxConcurrent: 1, sortOrder: 1 },
    update: {},
  });
}

async function person(key: string, stationId: string | null, level?: string, day = date) {
  const employee = await prisma.employee.create({
    data: { externalId: `${stamp}-${key}`, firstName: key, lastName: "Moss" },
  });
  const shift = await prisma.shift.create({
    data: {
      employeeId: employee.id,
      date: day,
      board: "caja",
      sourcePosition: "Caja",
      startAt: at("11:00 am", day),
      endAt: at("4:00 pm", day),
    },
  });
  if (stationId) {
    await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        employeeId: employee.id,
        stationId,
        hourStart: at("1:00 pm", day),
        hourEnd: at("2:00 pm", day),
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
    for (const id of ["green1", "blue", "multi", "purple1", "yellow", "nieves", "mana"]) {
      await cajaStation(id);
    }
    const ada = await person("Ada", "green1");
    const bea = await person("Bea", "blue", "forbidden");
    const cam = await person("Cam", "multi");
    await person("Dee", "purple1");
    await person("Eve", "yellow");
    await person("Fay", "nieves");
    await person("Gil", "mana");
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

  it("leaves a pending star break pending when two breaks already book that quarter", async () => {
    const day = "2036-06-17";
    const later = chicagoDateTime(day, "1:00 pm");
    for (const id of ["green1", "multi", "purple1", "yellow", "nieves", "mana", "mesero", "clean"]) {
      await cajaStation(id);
    }
    const fay = await person("Hue", "green1", undefined, day);
    const gus = await person("Ivy", "multi", undefined, day);
    await person("Jed", "purple1", undefined, day);
    await person("Kim", "yellow", undefined, day);
    await person("Lou", "nieves", undefined, day);
    await person("Ned", "mana", undefined, day);
    const ora = await person("Ora", "mesero", undefined, day);
    const pip = await person("Pip", "clean", undefined, day);
    const window = { startAt: at("1:00 pm", day), endAt: at("1:15 pm", day) };
    const fayShift = await prisma.shift.findFirstOrThrow({ where: { employeeId: fay.id, date: day } });
    await prisma.staffBreak.create({
      data: {
        employeeId: fay.id,
        shiftId: fayShift.id,
        board: "caja",
        date: day,
        startAt: window.startAt,
        endAt: window.endAt,
        actor: "test",
        status: "pending",
      },
    });
    for (const holder of [ora, pip]) {
      const shift = await prisma.shift.findFirstOrThrow({ where: { employeeId: holder.id, date: day } });
      await prisma.staffBreak.create({
        data: {
          employeeId: holder.id,
          shiftId: shift.id,
          board: "caja",
          date: day,
          startAt: window.startAt,
          endAt: window.endAt,
          actor: "test",
          status: "booked",
        },
      });
    }
    await saveOverlay({
      manager,
      board: "caja",
      date: day,
      kind: "switch",
      employeeId: fay.id,
      partnerEmployeeId: gus.id,
      window: "quarters",
      ...window,
      now: later,
    });
    expect(await prisma.staffBreak.count({
      where: { board: "caja", date: day, status: "booked" },
    })).toBe(2);
    const pending = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: fay.id, date: day } },
    });
    expect(pending.status).toBe("pending");
    expect(pending.coverEmployeeId).toBe(gus.id);
    expect(pending.startAt.getTime()).toBe(at("1:15 pm", day).getTime());
    expect(pending.endAt.getTime()).toBe(at("1:30 pm", day).getTime());
  });

  it("does not name a cover whose shift misses the rest of the break", async () => {
    const day = "2036-06-18";
    const later = chicagoDateTime(day, "1:00 pm");
    await cajaStation("green1");
    await cajaStation("multi");
    const ada = await person("Quill", "green1", undefined, day);
    const cam = await prisma.employee.create({
      data: { externalId: `${stamp}-Rex`, firstName: "Rex", lastName: "Moss" },
    });
    const camShift = await prisma.shift.create({
      data: {
        employeeId: cam.id,
        date: day,
        board: "caja",
        sourcePosition: "Caja",
        startAt: at("11:00 am", day),
        endAt: at("1:15 pm", day),
      },
    });
    await prisma.assignment.create({
      data: {
        shiftId: camShift.id,
        employeeId: cam.id,
        stationId: "multi",
        hourStart: at("1:00 pm", day),
        hourEnd: at("2:00 pm", day),
      },
    });
    const adaShift = await prisma.shift.findFirstOrThrow({ where: { employeeId: ada.id, date: day } });
    await prisma.staffBreak.create({
      data: {
        employeeId: ada.id,
        shiftId: adaShift.id,
        board: "caja",
        date: day,
        startAt: at("1:00 pm", day),
        endAt: at("1:30 pm", day),
        actor: "test",
        status: "pending",
      },
    });
    await saveOverlay({
      manager,
      board: "caja",
      date: day,
      kind: "switch",
      employeeId: ada.id,
      partnerEmployeeId: cam.id,
      window: "quarters",
      startAt: at("1:00 pm", day),
      endAt: at("1:15 pm", day),
      now: later,
    });
    const pending = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: ada.id, date: day } },
    });
    expect(pending.status).toBe("pending");
    expect(pending.coverEmployeeId).toBeNull();
  });

  it("leaves the cover unchanged when a full-shift partner overlays only one quarter", async () => {
    const day = "2036-06-19";
    const later = chicagoDateTime(day, "1:00 pm");
    await cajaStation("green1");
    await cajaStation("multi");
    const ada = await person("Sue", "green1", undefined, day);
    const cam = await person("Ted", "multi", undefined, day);
    const bea = await person("Uma", null, undefined, day);
    const adaShift = await prisma.shift.findFirstOrThrow({ where: { employeeId: ada.id, date: day } });
    const beaShift = await prisma.shift.findFirstOrThrow({ where: { employeeId: bea.id, date: day } });
    await prisma.staffBreak.create({
      data: {
        employeeId: ada.id,
        shiftId: adaShift.id,
        board: "caja",
        date: day,
        startAt: at("1:00 pm", day),
        endAt: at("1:30 pm", day),
        actor: "test",
        status: "pending",
        coverEmployeeId: bea.id,
        coverShiftId: beaShift.id,
      },
    });
    await saveOverlay({
      manager,
      board: "caja",
      date: day,
      kind: "switch",
      employeeId: ada.id,
      partnerEmployeeId: cam.id,
      window: "quarters",
      startAt: at("1:00 pm", day),
      endAt: at("1:15 pm", day),
      now: later,
    });
    const pending = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: ada.id, date: day } },
    });
    expect(pending.status).toBe("pending");
    expect(pending.coverEmployeeId).toBe(bea.id);
    expect(pending.coverShiftId).toBe(beaShift.id);
    expect(pending.startAt.getTime()).toBe(at("1:00 pm", day).getTime());
    expect(pending.endAt.getTime()).toBe(at("1:30 pm", day).getTime());
  });

  it("leaves the star empty when a booked cover is removed or switched away", () => {
    const start = at("2:00 pm");
    const end = at("2:15 pm");
    const shifts: SliceShift[] = ["ada", "cam", "bea"].map((id) => ({
      id,
      employeeId: id,
      board: "caja",
      startAt: at("11:00 am"),
      endAt: at("4:00 pm"),
      superseded: false,
      boardRemoved: false,
    }));
    const paints = [
      { employeeId: "ada", shiftId: "ada", stationId: "green1", hourStart: at("2:00 pm") },
      { employeeId: "cam", shiftId: "cam", stationId: "blue", hourStart: at("2:00 pm") },
      { employeeId: "bea", shiftId: "bea", stationId: "multi", hourStart: at("2:00 pm") },
    ];
    const breaks = [{
      employeeId: "ada",
      shiftId: "ada",
      board: "caja" as const,
      startAt: start,
      endAt: end,
      status: "booked" as const,
      coverEmployeeId: "cam",
    }];
    const base = {
      date,
      board: "caja" as const,
      now: start,
      stations: [{ id: "green1" }, { id: "blue" }, { id: "multi" }],
      starStationIds: ["green1"],
      shifts,
      paints,
      breaks,
    };
    const seated = buildDaySlices({ ...base, overlays: [] });
    const open = seated.slices.find((row) => row.start.getTime() === start.getTime());
    expect(open?.seats.find((seat) => seat.stationId === "green1")?.employeeId).toBe("cam");

    const removed = buildDaySlices({
      ...base,
      overlays: [{
        id: "rm",
        kind: "remove",
        employeeId: "cam",
        stationId: "blue",
        startAt: start,
        endAt: end,
      }],
    });
    const gap = removed.slices.find((row) => row.start.getTime() === start.getTime());
    expect(gap?.people.find((row) => row.employeeId === "ada")?.cell).toBe("break");
    expect(gap?.seats.some((seat) => seat.stationId === "green1")).toBe(false);
    expect(gap?.people.find((row) => row.employeeId === "cam")?.stationId ?? null).toBeNull();
    expect(gap?.emptyStarStationIds).toContain("green1");

    const switched = buildDaySlices({
      ...base,
      overlays: [{
        id: "sw",
        kind: "switch",
        employeeId: "cam",
        partnerEmployeeId: "bea",
        stationId: "multi",
        fromStationId: "blue",
        startAt: start,
        endAt: end,
      }],
    });
    const moved = switched.slices.find((row) => row.start.getTime() === start.getTime());
    expect(moved?.people.find((row) => row.employeeId === "ada")?.cell).toBe("break");
    expect(moved?.seats.find((seat) => seat.stationId === "green1")).toBeUndefined();
    expect(moved?.people.find((row) => row.employeeId === "cam")?.stationId).toBe("multi");
    expect(moved?.emptyStarStationIds).toContain("green1");
  });
});
