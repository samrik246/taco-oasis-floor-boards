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
});
