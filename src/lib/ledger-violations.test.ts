import { describe, expect, it } from "vitest";
import {
  assignmentMinutes,
  chicagoWeekBounds,
} from "@/lib/ledger";
import { chicagoDateTime } from "@/lib/time";
import { findBoardViolations } from "@/lib/violations";
import type { DayBoardDto } from "@/components/board/types";

describe("ledger week bounds + minutes", () => {
  it("uses Sunday–Saturday Chicago week containing the date", () => {
    // 2026-09-20 is a Sunday
    const sun = chicagoWeekBounds("2026-09-20");
    expect(sun.weekStart).toBe("2026-09-20");
    expect(sun.weekEnd).toBe("2026-09-26");

    // Friday Sep 18 → week starting Sep 13
    const fri = chicagoWeekBounds("2026-09-18");
    expect(fri.weekStart).toBe("2026-09-13");
    expect(fri.weekEnd).toBe("2026-09-19");
  });

  it("counts assignment duration in minutes", () => {
    const start = chicagoDateTime("2026-09-20", "10:00 am");
    const end = chicagoDateTime("2026-09-20", "11:00 am");
    expect(assignmentMinutes(start, end)).toBe(60);
  });
});

describe("findBoardViolations", () => {
  it("flags OUT_OF_SHIFT when assignment hour is outside shift", () => {
    const day: DayBoardDto = {
      board: "caja",
      date: "2026-09-20",
      stations: [
        {
          id: "yellow",
          label: "Yellow",
          color: "yellow",
          maxConcurrent: 1,
          sortOrder: 1,
          priority: 2,
        },
      ],
      shifts: [
        {
          id: "sh1",
          date: "2026-09-20",
          startAt: chicagoDateTime("2026-09-20", "8:00 am").toISOString(),
          endAt: chicagoDateTime("2026-09-20", "12:00 pm").toISOString(),
          sourcePosition: "Caja - Regular",
          board: "caja",
          employee: {
            id: "e1",
            externalId: "1",
            firstName: "Ada",
            lastName: "Lopez",
            email: null,
            abilities: [{ stationId: "yellow", level: "ok" }],
          },
          assignments: [
            {
              id: "a1",
              stationId: "yellow",
              // hour 14 is outside 8–12 window
              hourStart: chicagoDateTime("2026-09-20", "2:00 pm").toISOString(),
              hourEnd: chicagoDateTime("2026-09-20", "3:00 pm").toISOString(),
            },
          ],
        },
      ],
    };

    const v = findBoardViolations(day);
    expect(v.some((x) => x.code === "OUT_OF_SHIFT")).toBe(true);
    expect(v[0]?.employeeName).toContain("Ada");
  });

  it("returns empty when assignments are valid", () => {
    const day: DayBoardDto = {
      board: "caja",
      date: "2026-09-20",
      stations: [
        {
          id: "yellow",
          label: "Yellow",
          color: "yellow",
          maxConcurrent: 1,
          sortOrder: 1,
          priority: 2,
        },
      ],
      shifts: [
        {
          id: "sh1",
          date: "2026-09-20",
          startAt: chicagoDateTime("2026-09-20", "8:00 am").toISOString(),
          endAt: chicagoDateTime("2026-09-20", "5:00 pm").toISOString(),
          sourcePosition: "Caja - Regular",
          board: "caja",
          employee: {
            id: "e1",
            externalId: "1",
            firstName: "Ada",
            lastName: "Lopez",
            email: null,
            abilities: [{ stationId: "yellow", level: "ok" }],
          },
          assignments: [
            {
              id: "a1",
              stationId: "yellow",
              hourStart: chicagoDateTime("2026-09-20", "10:00 am").toISOString(),
              hourEnd: chicagoDateTime("2026-09-20", "11:00 am").toISOString(),
            },
          ],
        },
      ],
    };

    expect(findBoardViolations(day)).toEqual([]);
  });

  it("flags a forbidden placement from levels, or from abilityBlocked when levels are absent", () => {
    const base = (): DayBoardDto => ({
      board: "cocina",
      date: "2026-09-20",
      stations: [
        {
          id: "pdf_guia",
          label: "Guía",
          color: "orange",
          maxConcurrent: 1,
          sortOrder: 1,
          priority: null,
        },
      ],
      shifts: [
        {
          id: "sh1",
          date: "2026-09-20",
          startAt: chicagoDateTime("2026-09-20", "8:00 am").toISOString(),
          endAt: chicagoDateTime("2026-09-20", "5:00 pm").toISOString(),
          sourcePosition: "Cocina",
          board: "cocina",
          employee: {
            id: "e1",
            externalId: "1",
            firstName: "Nia",
            lastName: "Sol",
            email: null,
          },
          assignments: [
            {
              id: "a1",
              stationId: "pdf_guia",
              hourStart: chicagoDateTime("2026-09-20", "10:00 am").toISOString(),
              hourEnd: chicagoDateTime("2026-09-20", "11:00 am").toISOString(),
              abilityBlocked: true,
            },
          ],
        },
      ],
    });

    const owner = base();
    owner.shifts[0]!.employee.abilities = [{ stationId: "pdf_guia", level: "forbidden" }];
    const hidden = base();
    const allowed = base();
    allowed.shifts[0]!.assignments[0]!.abilityBlocked = false;
    const levelsWin = base();
    levelsWin.shifts[0]!.employee.abilities = [{ stationId: "pdf_guia", level: "ok" }];

    const ownerHit = findBoardViolations(owner).find((row) => row.code === "FORBIDDEN_ABILITY");
    const hiddenHit = findBoardViolations(hidden).find((row) => row.code === "FORBIDDEN_ABILITY");
    expect(ownerHit?.message).toBe("Employee is forbidden from station pdf_guia");
    expect(hiddenHit?.message).toBe(ownerHit?.message);
    expect(findBoardViolations(allowed).some((row) => row.code === "FORBIDDEN_ABILITY")).toBe(false);
    expect(findBoardViolations(levelsWin).some((row) => row.code === "FORBIDDEN_ABILITY")).toBe(false);
  });
});
