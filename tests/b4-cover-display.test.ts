/** @vitest-environment jsdom */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { projectCoverDisplay, type CoverDisplayShift, type CoverDisplayBooking, type CoverDisplayOverlay } from "@/lib/board/cover-display";
import { chicagoDateTime } from "@/lib/time";
import { savedHourSegments, savedStationIntervals } from "@/components/board/cover-display";
import { SavedCoverPanel, SavedHour } from "@/components/board/SavedCoverDisplay";
import { slicesForDay } from "@/components/board/day-slice-input";
import { SchedulePanel } from "@/components/board/SchedulePanel";
import { TimelinePanel } from "@/components/board/TimelinePanel";
import { messagesFor } from "@/lib/i18n";
import { scheduledHeadcounts } from "@/lib/board/headcounts";
import { saveLastBoard, readLastBoard, stripSharedTabletDay } from "@/lib/offline-board";
import type { DayBoardDto } from "@/components/board/types";
const date = "2037-10-01";
const at = (clock: string) => chicagoDateTime(date, clock);
const stations = [
  { id: "purple1", board: "caja", color: "purple", label: "Purple 1" },
  { id: "green1", board: "caja", color: "green", label: "Green 1" },
  { id: "green2", board: "caja", color: "lime", label: "Green 2" },
  { id: "blue", board: "caja", color: "blue", label: "Blue" },
  { id: "pdf_tq1r", board: "cocina", color: "red", label: "Tacos 1" },
];
function shift(id: string, board = "caja", stationId?: string): CoverDisplayShift {
  return { id: `${id}-shift`, employeeId: id, date, board, startAt: at("12:00 pm"), endAt: at("4:00 pm"), boardRemoved: false, supersededAt: null,
    employee: { firstName: id, lastName: "Example" }, assignments: stationId ? [12, 13, 14, 15].map(h => ({ stationId, hourStart: at(`${h - 12 || 12}:00 pm`), hourEnd: at(`${h - 11}:00 pm`) })) : [] };
}
function fixture() {
  const shifts = [shift("Dylan", "caja", "purple1"), shift("Dan", "other")];
  const bookings: CoverDisplayBooking[] = [{ id: "booked", employeeId: "Dylan", shiftId: "Dylan-shift", board: "caja", date,
    status: "booked", startAt: at("1:00 pm"), endAt: at("1:30 pm"), coverEmployeeId: "Dan", coverShiftId: "Dan-shift", shuffleEmployeeId: null, shuffleShiftId: null, auto: false }];
  return { board: "caja", date, now: at("12:00 pm"), stations, shifts, bookings, overlays: [] as CoverDisplayOverlay[] };
}
function dayFrom(input: ReturnType<typeof fixture>, board: "caja" | "cocina" = "caja"): DayBoardDto {
  return { board, date, stations: stations.filter(s => s.board === board).map((s, i) => ({ ...s, sortOrder: i, maxConcurrent: 1, priority: null })),
    shifts: input.shifts.filter(s => s.board === board).map(s => ({ id: s.id, date, board, sourcePosition: board === "caja" ? "Caja" : "Cocina",
      startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), employee: { id: s.employeeId, ...s.employee, email: null },
      assignments: s.assignments.map((a, i) => ({ id: `${s.id}-${i}`, stationId: a.stationId, hourStart: a.hourStart.toISOString(), hourEnd: a.hourEnd.toISOString() })) })),
    breaks: input.bookings.filter(b => b.board === board && b.status === "booked").map(b => ({ employeeId: b.employeeId, shiftId: b.shiftId, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), coverEmployeeId: b.coverEmployeeId })),
    coverDisplay: projectCoverDisplay({ ...input, board }) };
}
const moves = (input: ReturnType<typeof fixture>) => projectCoverDisplay(input).tracks.flatMap(t => t.segments.filter(s => s.kind === "cover").map(s => ({ ...s, employeeId: t.employeeId })));

describe("persisted cover identity and complete movement", () => {
  it("shows backup name, destination and half-hour without changing saved evidence or scheduled counts", () => {
    const input = fixture(), before = JSON.stringify(input), day = dayFrom(input);
    expect(moves(input)).toMatchObject([{ employeeId: "Dan", startAt: at("1:00 pm").toISOString(), endAt: at("1:30 pm").toISOString(), station: { id: "purple1" } }]);
    expect(day.shifts).toHaveLength(1); expect(scheduledHeadcounts(day, [12, 13, 14], input.now)).toEqual([1, 1, 1]);
    expect(savedStationIntervals(day, "purple1", 13)?.map(r => [r.name, r.startAt, r.endAt])).toEqual([
      ["Dan Example", at("1:00 pm").toISOString(), at("1:30 pm").toISOString()], ["Dylan Example", at("1:30 pm").toISOString(), at("2:00 pm").toISOString()],
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(["missing", "employee", "date", "short", "removed", "superseded", "ambiguous"])("%s recorded shift stays unavailable instead of picking a replacement", kind => {
    const input = fixture(); const s = input.shifts[1];
    if (kind === "missing") input.bookings[0].coverShiftId = "lost";
    if (kind === "employee") s.employeeId = "SomeoneElse";
    if (kind === "date") s.date = "2037-10-02";
    if (kind === "short") s.endAt = at("1:15 pm");
    if (kind === "removed") s.boardRemoved = true;
    if (kind === "superseded") s.supersededAt = at("12:30 pm");
    input.shifts.push({ ...shift("Dan", "other"), id: "replacement" });
    expect(projectCoverDisplay(input).unavailable).toHaveLength(1); expect(moves(input)).toEqual([]);
  });
  it("projects other-board away time and return without counting the cover as scheduled at the destination", () => {
    const input = fixture(); input.shifts[1] = shift("Dan", "cocina", "pdf_tq1r");
    const origin = dayFrom(input, "cocina"), target = dayFrom(input);
    expect(savedStationIntervals(origin, "pdf_tq1r", 13)).toMatchObject([{ name: "Dan Example", startAt: at("1:30 pm").toISOString() }]);
    expect(savedHourSegments(origin, "Dan-shift", 13)).toMatchObject([{ kind: "cover", station: { board: "caja" } }, { kind: "work", station: { board: "cocina" } }]);
    expect(scheduledHeadcounts(target, [13], input.now)).toEqual([1]); expect(scheduledHeadcounts(origin, [13], input.now)).toEqual([1]);
    const incoming = slicesForDay(target, input.now).slices[24], outgoing = slicesForDay(origin, input.now).slices[24];
    expect(incoming.seats).toContainEqual({ stationId: "purple1", employeeId: "Dan", source: "cover" });
    expect(outgoing.seats).not.toContainEqual(expect.objectContaining({ employeeId: "Dan" }));
    expect(slicesForDay(origin, input.now).slices[26].seats).toContainEqual(expect.objectContaining({ employeeId: "Dan", stationId: "pdf_tq1r" }));
  });
  it("splits both Shuffle legs when saved destinations change", () => {
    const input = fixture(); input.shifts[1] = shift("Dan", "caja", "green1"); input.shifts.push(shift("Robin", "other"));
    Object.assign(input.bookings[0], { shuffleEmployeeId: "Robin", shuffleShiftId: "Robin-shift", startAt: at("12:45 pm"), endAt: at("1:15 pm") });
    input.shifts[0].assignments[1].stationId = "blue";
    input.shifts[1].assignments[1].stationId = "green2";
    expect(moves(input).map(m => [m.employeeId, m.station?.id, m.startAt, m.endAt])).toEqual([
      ["Dan", "purple1", at("12:45 pm").toISOString(), at("1:00 pm").toISOString()], ["Dan", "blue", at("1:00 pm").toISOString(), at("1:15 pm").toISOString()],
      ["Robin", "green1", at("12:45 pm").toISOString(), at("1:00 pm").toISOString()], ["Robin", "green2", at("1:00 pm").toISOString(), at("1:15 pm").toISOString()],
    ]);
    input.bookings[0].shuffleShiftId = "lost";
    expect(moves(input)).toEqual([]); expect(projectCoverDisplay(input).unavailable).toHaveLength(1);
  });
  it("uses effective saved Switch positions and rejects removed movers", () => {
    const input = fixture(); input.overlays.push({ board: "caja", kind: "switch", employeeId: "Dylan", partnerEmployeeId: null, stationId: "blue", fromStationId: "purple1", startAt: at("1:15 pm"), endAt: at("2:00 pm"), cancelledAt: null });
    expect(moves(input).map(m => m.station?.id)).toEqual(["purple1", "blue"]);
    input.overlays.push({ ...input.overlays[0], kind: "remove", employeeId: "Dan", startAt: at("1:00 pm") });
    expect(moves(input)).toEqual([]);
  });
  it("keeps numbered auto:false and five-minute auto:true distinct", () => {
    const input = fixture(); input.shifts[0] = shift("Dylan", "caja", "green1"); input.shifts[1] = shift("Dan", "caja", "green2");
    expect(moves(input)[0].auto).toBe(false); input.bookings[0].auto = true; expect(moves(input)[0].auto).toBe(true);
  });
  it.each(["pending", "ended", "cancelled"])("%s rows place nobody", status => {
    const input = fixture(); input.bookings[0].status = status;
    expect(projectCoverDisplay(input)).toEqual({ version: 1, tracks: [], unavailable: [] });
  });
  it("preserves partial minutes and same-name identities", () => {
    const input = fixture(); input.shifts[0].endAt = at("3:20 pm"); input.shifts[1].employee = input.shifts[0].employee;
    const day = dayFrom(input); expect(day.coverDisplay?.tracks.map(t => t.employeeId)).toEqual(["Dylan", "Dan"]);
    expect(day.coverDisplay?.tracks[0].segments.at(-1)?.endAt).toBe(at("3:20 pm").toISOString());
    expect(scheduledHeadcounts(day, [15], input.now)).toEqual([1]);
  });
  it("does not let private paint redirect saved movement", () => {
    const input = fixture(), day = dayFrom(input);
    const preview = slicesForDay(day, input.now, [{ shiftId: "Dylan-shift", hour: 13, stationId: "blue" }]);
    expect(preview.slices[24].seats).toContainEqual({ stationId: "purple1", employeeId: "Dan", source: "cover" });
    expect(savedHourSegments(day, "Dylan-shift", 13)?.[0].station?.id).toBe("purple1");
  });
});

describe("public cache and proportional consumers", () => {
  it.each(["es", "en"] as const)("%s renders half-hour BREAK and supplemental cover rows in schedule/timeline", locale => {
    const day = dayFrom(fixture());
    for (const component of [createElement(SchedulePanel, { day, date, locale, t: messagesFor(locale), now: at("12:00 pm") }),
      createElement(TimelinePanel, { day, date, locale, t: messagesFor(locale), selectedHour: 13 })]) {
      const host = document.createElement("div"); host.innerHTML = renderToStaticMarkup(component);
      expect(host.querySelector('[data-testid="cover-row-Dan-shift"]')?.textContent).toContain("Dan Example");
      const strip = host.querySelector('[data-testid="break-stripe"]') as HTMLElement;
      expect(strip.style.width).toBe("50%"); expect(strip.style.left).toBe("0%");
      expect(host.querySelector('[data-testid="schedule-headcount-13"]')?.textContent ?? "1").toBe("1");
    }
  });
  it("clips cross-hour geometry to each column", () => {
    const input = fixture(); input.bookings[0].startAt = at("12:45 pm"); input.bookings[0].endAt = at("1:15 pm");
    const day = dayFrom(input);
    for (const [hour, left] of [[12, "75%"], [13, "0%"]] as const) {
      const host = document.createElement("div"); host.innerHTML = renderToStaticMarkup(createElement(SavedHour, { day, hour, locale: "es", segments: savedHourSegments(day, "Dylan-shift", hour)! }));
      const bar = host.querySelector('[data-kind="break"]') as HTMLElement; expect(bar.style.width).toBe("25%"); expect(bar.style.left).toBe(left);
    }
  });
  it("allowlists new nested public fields on both cache save and old-cache read", () => {
    const day = dayFrom(fixture()); const dirty = JSON.parse(JSON.stringify(day));
    dirty.coverDisplay.secret = "private-canary"; dirty.coverDisplay.tracks[0].abilities = "private-canary";
    dirty.coverDisplay.tracks[0].segments[0].station.secret = "private-canary";
    expect(JSON.stringify(stripSharedTabletDay(dirty))).not.toContain("private-canary");
    saveLastBoard({ board: "caja", date, day: dirty }, at("12:00 pm")); expect(window.localStorage.getItem("taco-oasis-last-board-v1")).not.toContain("private-canary");
    window.localStorage.setItem("taco-oasis-last-board-v1", JSON.stringify({ version: 1, board: "caja", date, day: dirty, savedAt: at("12:00 pm").toISOString() }));
    expect(JSON.stringify(readLastBoard(at("12:00 pm")))).not.toContain("private-canary"); expect(window.localStorage.getItem("taco-oasis-last-board-v1")).not.toContain("private-canary");
    expect(dirty.coverDisplay.secret).toBe("private-canary");
  });
  it("old snapshots show unavailable cover detail and factual BREAK instead of a replacement", () => {
    const day = dayFrom(fixture()); delete day.coverDisplay;
    expect(renderToStaticMarkup(createElement(SavedCoverPanel, { day, locale: "en" }))).toContain("Cover detail unavailable");
    expect(savedHourSegments(day, "Dylan-shift", 13)?.[0].kind).toBe("break");
    expect(slicesForDay(day, at("12:00 pm")).slices[24].seats).not.toContainEqual(expect.objectContaining({ employeeId: "Dan" }));
  });
});
