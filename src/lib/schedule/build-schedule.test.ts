import { describe, expect, it } from "vitest";
import {
  buildBlocksForHours,
  buildScheduleGrid,
  chicagoYmd,
  formatShiftWindowLabel,
  resolveRestOfDayStart,
  scheduleHasFullWidthStationBanners,
} from "@/lib/schedule/build-schedule";
import { stationShortCode } from "@/lib/schedule/station-codes";
import { chicagoDateTime } from "@/lib/time";
import { messagesFor } from "@/lib/i18n";

describe("station short codes", () => {
  it("maps cocina and caja stations", () => {
    expect(stationShortCode("fryer")).toBe("FRY");
    expect(stationShortCode("tortilla")).toBe("TOR");
    expect(stationShortCode("green1")).toBe("G1");
  });
});

describe("buildScheduleGrid", () => {
  const stations = [
    { id: "fryer", label: "Freidora", color: "orange", sortOrder: 0 },
    { id: "tortilla", label: "Tortilla", color: "yellow", sortOrder: 1 },
    { id: "carne", label: "Carne", color: "brown", sortOrder: 2 },
  ];

  const shifts = [
    {
      id: "s1",
      date: "2026-09-21",
      startAt: chicagoDateTime("2026-09-21", "8:00 am").toISOString(),
      endAt: chicagoDateTime("2026-09-21", "4:00 pm").toISOString(),
      employee: {
        id: "e1",
        externalId: "100",
        firstName: "Ana",
        lastName: "Lopez",
      },
      assignments: [
        {
          stationId: "fryer",
          hourStart: chicagoDateTime("2026-09-21", "8:00 am").toISOString(),
          hourEnd: chicagoDateTime("2026-09-21", "9:00 am").toISOString(),
        },
        {
          stationId: "fryer",
          hourStart: chicagoDateTime("2026-09-21", "9:00 am").toISOString(),
          hourEnd: chicagoDateTime("2026-09-21", "10:00 am").toISOString(),
        },
        {
          stationId: "tortilla",
          hourStart: chicagoDateTime("2026-09-21", "10:00 am").toISOString(),
          hourEnd: chicagoDateTime("2026-09-21", "11:00 am").toISOString(),
        },
      ],
    },
    {
      id: "s2",
      date: "2026-09-21",
      startAt: chicagoDateTime("2026-09-21", "10:00 am").toISOString(),
      endAt: chicagoDateTime("2026-09-21", "6:00 pm").toISOString(),
      employee: {
        id: "e2",
        externalId: "200",
        firstName: "Luis",
        lastName: "Perez",
      },
      assignments: [
        {
          stationId: "carne",
          hourStart: chicagoDateTime("2026-09-21", "10:00 am").toISOString(),
          hourEnd: chicagoDateTime("2026-09-21", "11:00 am").toISOString(),
        },
        {
          stationId: "carne",
          hourStart: chicagoDateTime("2026-09-21", "11:00 am").toISOString(),
          hourEnd: chicagoDateTime("2026-09-21", "12:00 pm").toISOString(),
        },
      ],
    },
  ];

  it("builds all-day grid sorted by name with position text and no banners", () => {
    const grid = buildScheduleGrid({
      date: "2026-09-21",
      shifts,
      stations,
      mode: "all-day",
      now: chicagoDateTime("2026-09-21", "3:00 pm"),
      unassignedGroupLabel: "Sin asignar",
    });
    expect(grid.hours[0]).toBe(7);
    expect(grid.hours[grid.hours.length - 1]).toBe(21);
    expect(grid.sort).toBe("name");
    expect(grid.stationBanners).toBe(false);
    expect(grid.sections.every((s) => s.label == null && s.kind === "thin")).toBe(
      true,
    );
    const ana = grid.sections
      .flatMap((s) => s.rows)
      .find((r) => r.externalId === "100");
    expect(ana?.blocks[0]).toMatchObject({
      stationId: "fryer",
      code: "FRY",
      text: "FRY",
      textKind: "position",
      startHour: 8,
      span: 2,
    });
    const hc10 = grid.headcount[grid.hours.indexOf(10)];
    expect(hc10).toBe(2);
    expect(grid.sections[0]?.rows.map((r) => r.name)).toEqual([
      "Ana Lopez",
      "Luis Perez",
    ]);
  });

  it("by position groups with thin labels and shows the person name", () => {
    const grid = buildScheduleGrid({
      date: "2026-09-21",
      shifts,
      stations,
      mode: "all-day",
      sort: "position",
      unassignedGroupLabel: "Sin asignar",
    });
    expect(grid.stationBanners).toBe(false);
    expect(grid.sections.map((s) => s.label)).toEqual(["Freidora", "Carne"]);
    expect(grid.sections.every((s) => s.kind === "thin")).toBe(true);
    const ana = grid.sections
      .find((s) => s.stationId === "fryer")
      ?.rows.find((r) => r.externalId === "100");
    expect(ana?.blocks.every((b) => b.text === "Ana" && b.textKind === "person")).toBe(
      true,
    );
    expect(ana?.blocks.map((b) => b.code)).toEqual(["FRY", "TOR"]);
    const luis = grid.sections
      .flatMap((s) => s.rows)
      .find((r) => r.externalId === "200");
    expect(luis?.blocks[0]?.text).toBe("Luis");
  });

  it("rest-of-day from now when viewing today", () => {
    const now = chicagoDateTime("2026-09-21", "1:00 pm");
    expect(chicagoYmd(now)).toBe("2026-09-21");
    const grid = buildScheduleGrid({
      date: "2026-09-21",
      shifts,
      stations,
      mode: "rest-of-day",
      now,
      unassignedGroupLabel: "Unassigned",
    });
    expect(grid.restRule).toBe("today-from-now");
    expect(grid.restStartHour).toBe(13);
    expect(grid.hours[0]).toBe(13);
    expect(grid.hours.includes(10)).toBe(false);
  });

  it("rest-of-day from first scheduled hour on other dates", () => {
    const now = chicagoDateTime("2026-09-22", "9:00 am");
    const grid = buildScheduleGrid({
      date: "2026-09-21",
      shifts,
      stations,
      mode: "rest-of-day",
      now,
      unassignedGroupLabel: "Unassigned",
    });
    expect(grid.restRule).toBe("other-from-first-scheduled");
    expect(grid.restStartHour).toBe(8);
    expect(grid.hours[0]).toBe(8);
  });

  it("merges consecutive same-station hours into blocks", () => {
    const map = new Map<number, string | null | undefined>([
      [8, "fryer"],
      [9, "fryer"],
      [10, "tortilla"],
      [11, null],
    ]);
    const stationsById = new Map(
      stations.map((s) => [s.id, s] as const),
    );
    const blocks = buildBlocksForHours(map, [8, 9, 10, 11], stationsById);
    expect(blocks).toEqual([
      {
        stationId: "fryer",
        code: "FRY",
        text: "FRY",
        textKind: "position",
        color: "orange",
        startHour: 8,
        span: 2,
      },
      {
        stationId: "tortilla",
        code: "TOR",
        text: "TOR",
        textKind: "position",
        color: "yellow",
        startHour: 10,
        span: 1,
      },
    ]);
  });

  it("never reports full-width station banners", () => {
    const grid = buildScheduleGrid({
      date: "2026-09-21",
      shifts,
      stations,
      mode: "all-day",
      sort: "position",
      unassignedGroupLabel: "Unassigned",
    });
    expect(scheduleHasFullWidthStationBanners(grid)).toBe(false);
  });
});

describe("resolveRestOfDayStart", () => {
  it("clamps today hour into the board grid", () => {
    const r = resolveRestOfDayStart({
      dateYmd: "2026-09-21",
      now: chicagoDateTime("2026-09-21", "5:00 am"),
      hoursWithShiftCoverage: [8, 9, 10],
    });
    expect(r.rule).toBe("today-from-now");
    expect(r.startHour).toBe(7);
  });
});

describe("formatShiftWindowLabel", () => {
  it("formats compact am/pm range", () => {
    expect(
      formatShiftWindowLabel(
        chicagoDateTime("2026-09-21", "7:00 am").toISOString(),
        chicagoDateTime("2026-09-21", "3:00 pm").toISOString(),
      ),
    ).toBe("7a–3p");
  });
});

describe("cocina schedule i18n", () => {
  it("uses Spanish schedule strings for cocina locale", () => {
    const es = messagesFor("es");
    expect(es.viewSchedule).toBe("Horario");
    expect(es.scheduleAllDay).toBe("Todo el día");
    expect(es.scheduleRestOfDay).toBe("Resto del día");
    expect(es.scheduleHeadcount).toBe("Personas");
    expect(es.scheduleTitle).toMatch(/Horario/i);
    expect(es.scheduleSortName).toBe("Por nombre");
    expect(es.scheduleSortPosition).toBe("Por puesto");
    expect(es.viewRush).toBe("Más ocupado");
    expect(es.rushBasis).toMatch(/ventas históricas/i);
    expect(es.rushPrep).toMatch(/antes del rush/i);
  });

  it("keeps English schedule strings for caja", () => {
    const en = messagesFor("en");
    expect(en.viewSchedule).toBe("Schedule");
    expect(en.scheduleAllDay).toBe("All day");
    expect(en.scheduleRestOfDay).toBe("Rest of day");
    expect(en.scheduleSortName).toBe("By name");
    expect(en.viewRush).toBe("Rush");
    expect(en.rushSummaryLead).toMatch(/Gets busier/i);
    expect(en.rushPrep).toMatch(/Prep before the rush/i);
  });
});
