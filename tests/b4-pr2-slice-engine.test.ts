import { describe, expect, it } from "vitest";
import { assessBreak } from "@/lib/breaks/rules";
import { chicagoDateTime } from "@/lib/time";
import { readBreakGate } from "@/lib/slices/break-gate";
import {
  buildDaySlices,
  personQuarters,
  sliceIndexesTouching,
  type DaySliceInput,
} from "@/lib/slices/day-slices";
import { amberEmptyShiftHours } from "@/lib/slices/paint-ratio";
import type { SliceShift } from "@/lib/slices/day-slices";

const date = "2034-06-04";

function at(clock: string): Date {
  return chicagoDateTime(date, clock);
}

function shift(partial: Partial<SliceShift> & Pick<SliceShift, "id" | "startAt" | "endAt">): SliceShift {
  return {
    employeeId: partial.employeeId ?? partial.id,
    board: partial.board ?? "cocina",
    superseded: partial.superseded ?? false,
    boardRemoved: partial.boardRemoved ?? false,
    ...partial,
  };
}

function input(partial: Partial<DaySliceInput> & Pick<DaySliceInput, "shifts">): DaySliceInput {
  return {
    date,
    board: "cocina",
    now: at("2:00 pm"),
    stations: [{ id: "pdf_tq1r" }],
    starStationIds: ["pdf_tq1r"],
    paints: [],
    breaks: [],
    overlays: [],
    ...partial,
  };
}

describe("B4 PR 2 slice engine", () => {
  it("a 2:45–3:15 break touches two hours and takes the seat", () => {
    const day = buildDaySlices(input({
      shifts: [shift({ id: "fay", startAt: at("11:00 am"), endAt: at("7:00 pm") })],
      paints: [
        { employeeId: "fay", shiftId: "fay", stationId: "pdf_tq2r", hourStart: at("2:00 pm") },
        { employeeId: "fay", shiftId: "fay", stationId: "pdf_tq2r", hourStart: at("3:00 pm") },
      ],
      breaks: [{
        employeeId: "fay",
        shiftId: "fay",
        board: "cocina",
        startAt: at("2:45 pm"),
        endAt: at("3:15 pm"),
        status: "booked",
      }],
      starStationIds: ["pdf_tq1r"],
    }));
    const indexes = sliceIndexesTouching(day, at("2:45 pm"), at("3:15 pm"));
    expect(indexes).toEqual([31, 32]);
    for (const index of indexes) {
      const slice = day.slices[index]!;
      const person = slice.people.find((row) => row.employeeId === "fay");
      expect(person?.cell).toBe("break");
      expect(slice.seats.some((seat) => seat.stationId === "pdf_tq2r")).toBe(false);
      expect(person?.counts).toBe(false);
    }
    const before = day.slices[30]!;
    expect(before.people.find((row) => row.employeeId === "fay")?.cell).toBe("seated");
  });

  it("a 3:30 end leaves 3:30 and 3:45 open on a painted star", () => {
    const day = buildDaySlices(input({
      shifts: [shift({ id: "ada", startAt: at("11:00 am"), endAt: at("3:30 pm") })],
      paints: [{ employeeId: "ada", shiftId: "ada", stationId: "pdf_tq1r", hourStart: at("3:00 pm") }],
    }));
    expect(personQuarters(day, "ada", 15).map((quarter) => quarter.kind)).toEqual([
      "seated",
      "seated",
      "open",
      "open",
    ]);
    expect(personQuarters(day, "ada", 15).map((quarter) => quarter.label)).toEqual([
      "3:00",
      "3:15",
      "3:30",
      "3:45",
    ]);
    const open = day.slices.filter((slice) => slice.emptyStarStationIds.includes("pdf_tq1r") && slice.index >= 34 && slice.index <= 35);
    expect(open.map((slice) => slice.index)).toEqual([34, 35]);
  });

  it("a 3:20 end leaves the 3:15 quarter open", () => {
    const day = buildDaySlices(input({
      shifts: [shift({ id: "ada", startAt: at("11:00 am"), endAt: at("3:20 pm") })],
      paints: [{ employeeId: "ada", shiftId: "ada", stationId: "pdf_tq1r", hourStart: at("3:00 pm") }],
    }));
    expect(personQuarters(day, "ada", 15).map((quarter) => quarter.kind)).toEqual([
      "seated",
      "open",
      "open",
      "open",
    ]);
  });

  it("a superseded shift does not keep its paint", () => {
    const day = buildDaySlices(input({
      shifts: [shift({
        id: "old",
        startAt: at("11:00 am"),
        endAt: at("7:00 pm"),
        superseded: true,
      })],
      paints: [{ employeeId: "old", shiftId: "old", stationId: "pdf_tq1r", hourStart: at("3:00 pm") }],
    }));
    const slice = day.slices[32]!;
    expect(slice.people.find((row) => row.employeeId === "old")).toBeUndefined();
    expect(slice.seats).toEqual([]);
    expect(slice.emptyStarStationIds).toContain("pdf_tq1r");
    expect(slice.presentNotOnBreak).toBe(0);
  });

  it("paint on a superseded shift does not fill the replacement shift", () => {
    const shifts = [
      shift({
        id: "old",
        employeeId: "ada",
        startAt: at("11:00 am"),
        endAt: at("7:00 pm"),
        superseded: true,
      }),
      shift({
        id: "new",
        employeeId: "ada",
        startAt: at("11:00 am"),
        endAt: at("7:00 pm"),
      }),
    ];
    const day = buildDaySlices(input({
      shifts,
      paints: [{ employeeId: "ada", shiftId: "old", stationId: "pdf_tq1r", hourStart: at("3:00 pm") }],
    }));
    const open = day.slices[32]!;
    expect(open.people.find((row) => row.employeeId === "ada")).toMatchObject({
      cell: "open",
      paintStationId: null,
      stationId: null,
    });
    expect(open.seats).toEqual([]);
    expect(open.emptyStarStationIds).toContain("pdf_tq1r");

    const replaced = buildDaySlices(input({
      shifts,
      paints: [
        { employeeId: "ada", shiftId: "old", stationId: "pdf_tq1r", hourStart: at("3:00 pm") },
        { employeeId: "ada", shiftId: "new", stationId: "pdf_tq2r", hourStart: at("3:00 pm") },
      ],
      starStationIds: ["pdf_tq1r"],
    }));
    expect(replaced.slices[32]?.seats).toEqual([
      { stationId: "pdf_tq2r", employeeId: "ada", source: "paint" },
    ]);
    expect(replaced.slices[32]?.emptyStarStationIds).toContain("pdf_tq1r");
  });

  it("a remove overlay wins over paint and the person still counts", () => {
    const day = buildDaySlices(input({
      shifts: [shift({ id: "ada", startAt: at("11:00 am"), endAt: at("7:00 pm") })],
      paints: [{ employeeId: "ada", shiftId: "ada", stationId: "pdf_tq1r", hourStart: at("3:00 pm") }],
      overlays: [{
        id: "ov",
        kind: "remove",
        employeeId: "ada",
        stationId: "pdf_tq1r",
        startAt: at("3:00 pm"),
        endAt: at("3:15 pm"),
      }],
    }));
    const removed = day.slices[32]!;
    const kept = day.slices[33]!;
    expect(removed.people.find((row) => row.employeeId === "ada")).toMatchObject({ cell: "open", counts: true });
    expect(removed.seats).toEqual([]);
    expect(removed.emptyStarStationIds).toContain("pdf_tq1r");
    expect(kept.seats).toEqual([{ stationId: "pdf_tq1r", employeeId: "ada", source: "paint" }]);
  });

  it("a one-day mark adds a star without seating anyone", () => {
    const day = buildDaySlices(input({
      shifts: [shift({ id: "ada", startAt: at("11:00 am"), endAt: at("7:00 pm") })],
      starStationIds: ["pdf_tq1r", "pdf_pstl"],
    }));
    expect(day.starCount).toBe(2);
    expect(day.slices[32]?.emptyStarStationIds).toEqual(["pdf_tq1r", "pdf_pstl"]);
    expect(day.slices[0]?.emptyStarStationIds).toEqual(["pdf_tq1r", "pdf_pstl"]);
  });

  it("a pending break places nobody", () => {
    const day = buildDaySlices(input({
      shifts: [shift({ id: "ada", startAt: at("11:00 am"), endAt: at("7:00 pm") })],
      paints: [{ employeeId: "ada", shiftId: "ada", stationId: "pdf_tq1r", hourStart: at("3:00 pm") }],
      breaks: [{
        employeeId: "ada",
        shiftId: "ada",
        board: "cocina",
        startAt: at("3:00 pm"),
        endAt: at("3:15 pm"),
        status: "pending",
        coverEmployeeId: "bea",
      }],
    }));
    const slice = day.slices[32]!;
    expect(slice.people.find((row) => row.employeeId === "ada")?.cell).toBe("seated");
    expect(slice.bookedBreaks).toBe(0);
    expect(slice.seats.map((seat) => seat.employeeId)).toEqual(["ada"]);
  });

  it("the break gate reads the slices and assessBreak is unchanged", () => {
    const shifts = [shift({ id: "fay", startAt: at("11:00 am"), endAt: at("7:00 pm") })];
    const gate = readBreakGate({
      date,
      employeeId: "fay",
      startAt: at("2:45 pm"),
      endAt: at("3:15 pm"),
      shifts,
    });
    expect(gate.sliceIndexes).toEqual([31, 32]);
    expect(gate.everyTouchedSliceInsideShift).toBe(true);
    expect(assessBreak({
      date,
      startAt: at("2:00 pm"),
      endAt: at("3:00 pm"),
      shifts,
      otherBreaks: [],
    })).toEqual({ shiftId: "fay", board: "cocina" });
    expect(assessBreak({
      date,
      startAt: at("2:00 pm"),
      endAt: at("3:00 pm"),
      shifts,
      otherBreaks: [{ board: "cocina", startAt: at("2:30 pm"), endAt: at("2:45 pm") }],
    })).toEqual({ code: "OVERLAP" });
  });
});

describe("B4 PR 2 amber hours", () => {
  const hours = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const row = shift({ id: "ada", startAt: at("7:00 am"), endAt: at("5:00 pm") });

  function paints(openHour: number) {
    return hours.filter((hour) => hour !== openHour).map((hour) => ({
      employeeId: "ada",
      shiftId: "ada",
      stationId: "pdf_tq2r",
      hourStart: at(`${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? "pm" : "am"}`),
    }));
  }

  it("marks every empty on-shift hour at 90% today, and none below that or on another day", () => {
    const marked = amberEmptyShiftHours({
      date,
      today: date,
      board: "cocina",
      shifts: [row],
      paints: paints(16),
    });
    expect(marked.get("ada")).toEqual([16]);

    const under = amberEmptyShiftHours({
      date,
      today: date,
      board: "cocina",
      shifts: [row],
      paints: paints(16).filter((paint) => paint.hourStart.getTime() !== at("4:00 pm").getTime() && paint.hourStart.getTime() !== at("3:00 pm").getTime()),
    });
    expect(under.size).toBe(0);

    const otherDay = amberEmptyShiftHours({
      date,
      today: "2034-06-05",
      board: "cocina",
      shifts: [row],
      paints: paints(16),
    });
    expect(otherDay.size).toBe(0);
  });
});
