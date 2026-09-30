import { describe, expect, it } from "vitest";
import { slicesForDay } from "@/components/board/day-slice-input";
import type { DayBoardDto } from "@/components/board/types";
import { screenOverlays, type OverlayRecord } from "@/lib/overlays/read";
import { buildDaySlices, type SliceShift } from "@/lib/slices/day-slices";
import { chicagoDateTime } from "@/lib/time";

const date = "2034-08-14";

function at(clock: string): Date {
  return chicagoDateTime(date, clock);
}

function row(partial: Partial<OverlayRecord> & Pick<OverlayRecord, "id" | "endAt">): OverlayRecord {
  return {
    date,
    board: "cocina",
    kind: "remove",
    employeeId: "ada",
    partnerEmployeeId: null,
    stationId: "pdf_tq1r",
    fromStationId: null,
    startAt: at("11:00 am"),
    managerId: "mgr",
    managerName: "Gerente",
    cancelledAt: null,
    endReason: null,
    createdAt: at("11:00 am"),
    ...partial,
  };
}

function shift(): SliceShift {
  return {
    id: "ada",
    employeeId: "ada",
    board: "cocina",
    startAt: at("11:00 am"),
    endAt: at("4:00 pm"),
    superseded: false,
    boardRemoved: false,
  };
}

describe("B4 PR 4 overlay read", () => {
  it("hides an ended or cancelled window and lets a live remove open the painted seat", () => {
    const now = at("2:00 pm");
    const paints = [{ employeeId: "ada", shiftId: "ada", stationId: "pdf_tq1r", hourStart: at("2:00 pm") }];
    const ended = row({ id: "ended", endAt: at("1:00 pm") });
    const cancelled = row({ id: "cancelled", endAt: at("4:00 pm"), cancelledAt: at("1:30 pm"), endReason: "cancel" });
    const live = row({ id: "live", endAt: at("4:00 pm") });
    expect(screenOverlays([ended, cancelled, live], now).map((item) => item.id)).toEqual(["live"]);

    const hidden = buildDaySlices({
      date,
      board: "cocina",
      now,
      stations: [{ id: "pdf_tq1r" }],
      starStationIds: ["pdf_tq1r"],
      shifts: [shift()],
      paints,
      breaks: [],
      overlays: screenOverlays([ended, cancelled], now),
    });
    const painted = hidden.slices[28]!;
    expect(painted.people.find((person) => person.employeeId === "ada")?.cell).toBe("seated");
    expect(painted.seats).toEqual([{ stationId: "pdf_tq1r", employeeId: "ada", source: "paint" }]);
    expect(paints).toEqual([{ employeeId: "ada", shiftId: "ada", stationId: "pdf_tq1r", hourStart: at("2:00 pm") }]);

    const opened = buildDaySlices({
      date,
      board: "cocina",
      now,
      stations: [{ id: "pdf_tq1r" }],
      starStationIds: ["pdf_tq1r"],
      shifts: [shift()],
      paints,
      breaks: [],
      overlays: screenOverlays([live], now),
    });
    const gap = opened.slices[28]!;
    expect(gap.people.find((person) => person.employeeId === "ada")).toMatchObject({
      cell: "open",
      counts: true,
      stationId: null,
    });
    expect(gap.seats).toEqual([]);
    expect(gap.emptyStarStationIds).toContain("pdf_tq1r");
  });

  it("reads the same screen filter from the day payload", () => {
    const now = at("2:00 pm");
    const day: DayBoardDto = {
      board: "cocina",
      date,
      stations: [],
      shifts: [{
        id: "ada",
        date,
        startAt: at("11:00 am").toISOString(),
        endAt: at("4:00 pm").toISOString(),
        sourcePosition: "Cocina",
        board: "cocina",
        employee: { id: "ada", firstName: "Ada", lastName: "Moss", email: null },
        assignments: [{
          id: "paint",
          stationId: "pdf_tq1r",
          hourStart: at("2:00 pm").toISOString(),
          hourEnd: at("3:00 pm").toISOString(),
        }],
      }],
      overlays: [{
        id: "ended",
        kind: "remove",
        employeeId: "ada",
        partnerEmployeeId: null,
        stationId: "pdf_tq1r",
        fromStationId: null,
        startAt: at("11:00 am").toISOString(),
        endAt: at("1:00 pm").toISOString(),
        managerId: "mgr",
        managerName: "Gerente",
        cancelledAt: null,
        endReason: null,
      }],
    };
    const slices = slicesForDay(day, now);
    expect(slices.slices[28]?.seats).toEqual([{ stationId: "pdf_tq1r", employeeId: "ada", source: "paint" }]);
    expect(day.shifts[0]?.assignments).toHaveLength(1);
  });
});
