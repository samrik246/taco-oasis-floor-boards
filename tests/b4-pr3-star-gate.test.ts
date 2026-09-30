import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { saveBreak } from "@/lib/breaks/rules";
import { listBreaksNow } from "@/lib/breaks/now";
import { assessStarGate } from "@/lib/slices/break-gate";
import type { SlicePaint, SliceShift } from "@/lib/slices/day-slices";
import { chicagoDateOffset } from "@/lib/date-math";
import { chicagoDateTime } from "@/lib/time";

const date = chicagoDateOffset("2034-06-04", Math.floor(Date.now() % 4000));
const filledDate = chicagoDateOffset(date, 3);
const prisma = new PrismaClient();
const stamp = `b4pr3-${Date.now()}`;
const stars = [...MANDATORY_STATIONS_BY_BOARD.cocina];

function at(clock: string, day = date): Date {
  return chicagoDateTime(day, clock);
}

function shift(id: string, start: string, end: string, board = "cocina"): SliceShift {
  return {
    id,
    employeeId: id,
    board,
    startAt: at(start),
    endAt: at(end),
    superseded: false,
    boardRemoved: false,
  };
}

function paint(employeeId: string, stationId: string, clock: string): SlicePaint {
  return { employeeId, shiftId: employeeId, stationId, hourStart: at(clock) };
}

function gate(partial: Partial<Parameters<typeof assessStarGate>[0]> & Pick<Parameters<typeof assessStarGate>[0], "employeeId" | "startAt" | "endAt" | "shifts">) {
  return assessStarGate({
    date,
    board: "cocina",
    paints: [],
    breaks: [],
    starStationIds: ["pdf_tq1r"],
    ...partial,
  });
}

describe("B4 PR 3 star gate", () => {
  it("books before 11:00 even when a star seat is empty", () => {
    expect(gate({
      employeeId: "ada",
      startAt: at("9:00 am"),
      endAt: at("9:15 am"),
      shifts: [shift("ada", "8:00 am", "4:00 pm")],
    })).toEqual({ status: "booked", coverEmployeeId: null, coverShiftId: null, shuffleEmployeeId: null, shuffleShiftId: null });
  });

  it("refuses a break that touches the open end of a star shift", () => {
    expect(gate({
      employeeId: "bea",
      startAt: at("3:30 pm"),
      endAt: at("3:45 pm"),
      shifts: [shift("bea", "8:00 am", "4:00 pm"), shift("ada", "11:00 am", "3:30 pm")],
      paints: [paint("ada", "pdf_tq1r", "3:00 pm")],
    })).toEqual({ code: "EMPTY_STAR" });
  });

  it("allows a quarter the star shift still covers", () => {
    expect(gate({
      employeeId: "bea",
      startAt: at("3:00 pm"),
      endAt: at("3:15 pm"),
      shifts: [shift("bea", "8:00 am", "4:00 pm"), shift("ada", "11:00 am", "3:30 pm")],
      paints: [paint("ada", "pdf_tq1r", "3:00 pm")],
    })).toEqual({ status: "booked", coverEmployeeId: null, coverShiftId: null, shuffleEmployeeId: null, shuffleShiftId: null });
  });

  it("a star person waits, and a free cover books onto that seat", () => {
    const shifts = [shift("ada", "11:00 am", "4:00 pm"), shift("bea", "11:00 am", "4:00 pm")];
    const paints = [paint("ada", "pdf_tq1r", "2:00 pm")];
    expect(gate({
      employeeId: "ada",
      startAt: at("2:00 pm"),
      endAt: at("2:15 pm"),
      shifts,
      paints,
    })).toEqual({ code: "NEEDS_COVER" });
    expect(gate({
      employeeId: "ada",
      startAt: at("2:00 pm"),
      endAt: at("2:15 pm"),
      shifts,
      paints,
      coverEmployeeId: "bea",
    })).toEqual({ status: "booked", coverEmployeeId: "bea", coverShiftId: "bea", shuffleEmployeeId: null, shuffleShiftId: null });
  });

  it("refuses a cover who already sits a star", () => {
    expect(gate({
      employeeId: "ada",
      startAt: at("2:00 pm"),
      endAt: at("2:15 pm"),
      shifts: [shift("ada", "11:00 am", "4:00 pm"), shift("cam", "11:00 am", "4:00 pm")],
      paints: [paint("ada", "pdf_tq1r", "2:00 pm"), paint("cam", "pdf_tf1r", "2:00 pm")],
      starStationIds: ["pdf_tq1r", "pdf_tf1r"],
      coverEmployeeId: "cam",
    })).toEqual({ code: "BAD_COVER" });
  });

  it("an empty board refuses the afternoon save and still books the morning", async () => {
    const ada = await prisma.employee.create({
      data: { externalId: `${stamp}-ada`, firstName: "Ada", lastName: "Moss" },
    });
    await prisma.shift.create({
      data: {
        employeeId: ada.id,
        date,
        board: "cocina",
        sourcePosition: "Cocina",
        startAt: at("8:00 am"),
        endAt: at("4:00 pm"),
      },
    });
    await expect(saveBreak({
      employeeId: ada.id,
      date,
      startAt: at("2:00 pm"),
      endAt: at("2:15 pm"),
    })).rejects.toMatchObject({ code: "EMPTY_STAR" });
    expect(await prisma.staffBreak.count({ where: { employeeId: ada.id } })).toBe(0);
    const morning = await saveBreak({
      employeeId: ada.id,
      date,
      startAt: at("9:00 am"),
      endAt: at("9:15 am"),
    });
    expect(morning.status).toBe("booked");
  });

  it("a filled star seat waits without taking a spot", async () => {
    const people = await Promise.all(stars.map((stationId, index) => prisma.employee.create({
      data: { externalId: `${stamp}-star-${index}`, firstName: `Star${index}`, lastName: "Moss" },
    })));
    const shifts = await Promise.all(people.map((person) => prisma.shift.create({
      data: {
        employeeId: person.id,
        date: filledDate,
        board: "cocina",
        sourcePosition: "Cocina",
        startAt: at("11:00 am", filledDate),
        endAt: at("4:00 pm", filledDate),
      },
    })));
    await Promise.all(shifts.map((row, index) => prisma.assignment.create({
      data: {
        shiftId: row.id,
        employeeId: people[index]!.id,
        stationId: stars[index]!,
        hourStart: at("2:00 pm", filledDate),
        hourEnd: at("3:00 pm", filledDate),
      },
    })));
    const asker = people[0]!;
    const waiting = await saveBreak({
      employeeId: asker.id,
      date: filledDate,
      startAt: at("2:00 pm", filledDate),
      endAt: at("2:15 pm", filledDate),
    });
    expect(waiting.status).toBe("pending");
    const row = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: asker.id, date: filledDate } },
    });
    expect(row.status).toBe("pending");
    expect(row.coverEmployeeId).toBeNull();
    const listed = await listBreaksNow("cocina", at("2:05 pm", filledDate));
    expect(listed.now.map((item) => item.firstName)).not.toContain("Star0");
  });
});
