import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadBreakCovers } from "@/lib/breaks/manage";
import { listBreakCovers, type BreakCover } from "@/lib/breaks/covers";
import { saveBreak } from "@/lib/breaks/rules";
import { MANDATORY_STATIONS_BY_BOARD } from "@/lib/mandatory";
import { buildDaySlices, type SlicePaint, type SliceShift } from "@/lib/slices/day-slices";
import { chicagoDateOffset } from "@/lib/date-math";
import { chicagoDateTime } from "@/lib/time";

const date = "2035-08-06";
const coverDate = chicagoDateOffset("2036-02-02", Math.floor(Date.now() % 500));
const prisma = new PrismaClient();
const stamp = `b4pr3c-${Date.now()}`;
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

function paint(employeeId: string, stationId: string, clock = "2:00 pm"): SlicePaint {
  return { employeeId, shiftId: employeeId, stationId, hourStart: at(clock) };
}

function names(ids: string[]): Map<string, string> {
  return new Map(ids.map((id) => [id, id[0]!.toUpperCase() + id.slice(1)]));
}

function label(row: BreakCover): string {
  return row.kind === "simple" ? row.firstName : `${row.moves[0].firstName} y ${row.moves[1].firstName}`;
}

function listed(partial: Partial<Parameters<typeof listBreakCovers>[0]> & Pick<Parameters<typeof listBreakCovers>[0], "employeeId" | "shifts">) {
  const ids = partial.shifts.map((row) => row.employeeId);
  return listBreakCovers({
    date,
    board: "cocina",
    startAt: at("2:00 pm"),
    endAt: at("2:15 pm"),
    paints: [],
    breaks: [],
    starStationIds: ["pdf_tq1r"],
    abilities: [],
    names: names(ids),
    ...partial,
  });
}

describe("B4 PR 3 cover list", () => {
  it("lists preferred, then ok, then training, and leaves the level off the name", () => {
    const rows = listed({
      employeeId: "ada",
      shifts: [
        shift("ada", "11:00 am", "4:00 pm"),
        shift("cam", "11:00 am", "4:00 pm"),
        shift("amy", "11:00 am", "4:00 pm"),
        shift("bo", "11:00 am", "4:00 pm"),
        shift("dee", "11:00 am", "4:00 pm"),
        shift("fay", "11:00 am", "4:00 pm"),
      ],
      paints: [paint("ada", "pdf_tq1r")],
      abilities: [
        { employeeId: "cam", stationId: "pdf_tq1r", level: "preferred" },
        { employeeId: "bo", stationId: "pdf_tq1r", level: "ok" },
        { employeeId: "dee", stationId: "pdf_tq1r", level: "training" },
        { employeeId: "fay", stationId: "pdf_tq1r", level: "forbidden" },
      ],
    });
    expect(rows.map(label)).toEqual(["Cam", "Amy", "Bo", "Dee"]);
    expect(rows.every((row) => row.kind === "simple")).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/preferred|training|forbidden|fuerte|bien|poco|"level"/);
  });

  it("puts a two-move Shuffle after the simple names and refuses a chain of three", () => {
    const simpleThenShuffle = listed({
      employeeId: "ada",
      shifts: [
        shift("ada", "11:00 am", "4:00 pm"),
        shift("gus", "11:00 am", "4:00 pm"),
        shift("bea", "11:00 am", "4:00 pm"),
      ],
      paints: [paint("ada", "pdf_tq1r"), paint("gus", "pdf_tf1r")],
      starStationIds: ["pdf_tq1r", "pdf_tf1r"],
      abilities: [
        { employeeId: "bea", stationId: "pdf_tq1r", level: "ok" },
        { employeeId: "gus", stationId: "pdf_tq1r", level: "preferred" },
        { employeeId: "bea", stationId: "pdf_tf1r", level: "training" },
      ],
    });
    expect(simpleThenShuffle.map(label)).toEqual(["Bea", "Gus y Bea"]);
    expect(simpleThenShuffle[1]).toMatchObject({
      kind: "shuffle",
      moves: [
        { employeeId: "gus", firstName: "Gus" },
        { employeeId: "bea", firstName: "Bea" },
      ],
    });

    const chain = listed({
      employeeId: "ada",
      shifts: [
        shift("ada", "11:00 am", "4:00 pm"),
        shift("gus", "11:00 am", "4:00 pm"),
        shift("cam", "11:00 am", "4:00 pm"),
        shift("bea", "11:00 am", "4:00 pm"),
      ],
      paints: [paint("ada", "pdf_tq1r"), paint("gus", "pdf_tf1r"), paint("cam", "pdf_pr1e")],
      starStationIds: ["pdf_tq1r", "pdf_tf1r", "pdf_pr1e"],
      abilities: [
        { employeeId: "gus", stationId: "pdf_tq1r", level: "preferred" },
        { employeeId: "cam", stationId: "pdf_tq1r", level: "forbidden" },
        { employeeId: "bea", stationId: "pdf_tq1r", level: "forbidden" },
        { employeeId: "cam", stationId: "pdf_tf1r", level: "preferred" },
        { employeeId: "bea", stationId: "pdf_tf1r", level: "forbidden" },
        { employeeId: "bea", stationId: "pdf_pr1e", level: "preferred" },
      ],
    });
    expect(chain).toEqual([]);
  });

  it("offers a Picar Carne shift only while that shift covers the window", () => {
    const rows = listed({
      employeeId: "ada",
      shifts: [
        shift("ada", "11:00 am", "4:00 pm"),
        shift("pico", "11:00 am", "4:00 pm", "other"),
        shift("late", "8:00 am", "2:00 pm", "other"),
      ],
      paints: [paint("ada", "pdf_tq1r")],
      abilities: [{ employeeId: "pico", stationId: "pdf_tq1r", level: "preferred" }],
    });
    expect(rows.map(label)).toEqual(["Pico"]);
  });

  it("seats both Shuffle moves and leaves the star filled", () => {
    const day = buildDaySlices({
      date,
      board: "cocina",
      now: at("2:00 pm"),
      stations: [{ id: "pdf_tq1r" }, { id: "pdf_tf1r" }],
      starStationIds: ["pdf_tq1r", "pdf_tf1r"],
      shifts: [
        shift("ada", "11:00 am", "4:00 pm"),
        shift("gus", "11:00 am", "4:00 pm"),
        shift("bea", "11:00 am", "4:00 pm"),
      ],
      paints: [paint("ada", "pdf_tq1r"), paint("gus", "pdf_tf1r")],
      breaks: [{
        employeeId: "ada",
        shiftId: "ada",
        board: "cocina",
        startAt: at("2:00 pm"),
        endAt: at("2:15 pm"),
        status: "booked",
        coverEmployeeId: "gus",
        shuffleEmployeeId: "bea",
      }],
      overlays: [],
    });
    const slice = day.slices.find((row) => row.start.getTime() === at("2:00 pm").getTime());
    expect(slice?.seats).toEqual([
      { stationId: "pdf_tq1r", employeeId: "gus", source: "cover" },
      { stationId: "pdf_tf1r", employeeId: "bea", source: "cover" },
    ]);
    expect(slice?.emptyStarStationIds).toEqual([]);
  });

  it("one tap stores both Shuffle moves, and a name off the list is refused", async () => {
    const people = await Promise.all(stars.map((stationId, index) => prisma.employee.create({
      data: { externalId: `${stamp}-${stationId}`, firstName: index === 1 ? "Gus" : `Seat${index}`, lastName: "Moss" },
    })));
    const bea = await prisma.employee.create({
      data: { externalId: `${stamp}-bea`, firstName: "Bea", lastName: "Moss" },
    });
    const rows = await Promise.all([...people, bea].map((person) => prisma.shift.create({
      data: {
        employeeId: person.id,
        date: coverDate,
        board: "cocina",
        sourcePosition: "Cocina",
        startAt: at("11:00 am", coverDate),
        endAt: at("4:00 pm", coverDate),
      },
    })));
    await Promise.all(people.map((person, index) => prisma.assignment.create({
      data: {
        shiftId: rows[index]!.id,
        employeeId: person.id,
        stationId: stars[index]!,
        hourStart: at("2:00 pm", coverDate),
        hourEnd: at("3:00 pm", coverDate),
      },
    })));
    const asker = people[0]!;
    const mover = people[1]!;
    const moverShift = rows[1]!;
    const beaShift = rows[rows.length - 1]!;
    await prisma.employeeStationAbility.createMany({
      data: [
        { employeeId: mover.id, stationId: stars[0]!, level: "preferred" },
        { employeeId: bea.id, stationId: stars[1]!, level: "preferred" },
        ...stars.filter((stationId) => stationId !== stars[1]).map((stationId) => ({
          employeeId: bea.id,
          stationId,
          level: "forbidden",
        })),
      ],
    });
    const window = {
      board: "cocina" as const,
      employeeId: asker.id,
      date: coverDate,
      startAt: at("2:00 pm", coverDate),
      endAt: at("2:15 pm", coverDate),
    };
    const choices = await loadBreakCovers(window);
    expect(choices.map(label)).toEqual(["Gus y Bea"]);
    expect(JSON.stringify(choices)).not.toMatch(/preferred|training|forbidden|fuerte|bien|poco|"level"/);

    const waiting = await saveBreak({
      employeeId: asker.id,
      date: coverDate,
      startAt: window.startAt,
      endAt: window.endAt,
    });
    expect(waiting.status).toBe("pending");
    expect(waiting.covers.map(label)).toEqual(["Gus y Bea"]);
    await expect(saveBreak({
      employeeId: asker.id,
      date: coverDate,
      startAt: window.startAt,
      endAt: window.endAt,
      coverEmployeeId: bea.id,
    })).rejects.toMatchObject({ code: "BAD_COVER" });

    const booked = await saveBreak({
      employeeId: asker.id,
      date: coverDate,
      startAt: window.startAt,
      endAt: window.endAt,
      coverEmployeeId: mover.id,
      shuffleEmployeeId: bea.id,
    });
    expect(booked.status).toBe("booked");
    const row = await prisma.staffBreak.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: asker.id, date: coverDate } },
    });
    expect(row.coverEmployeeId).toBe(mover.id);
    expect(row.coverShiftId).toBe(moverShift.id);
    expect(row.shuffleEmployeeId).toBe(bea.id);
    expect(row.shuffleShiftId).toBe(beaShift.id);
    expect(row.status).toBe("booked");
  });
});
