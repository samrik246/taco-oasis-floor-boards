import { describe, expect, it } from "vitest";
import { chicagoHourStart } from "@/lib/hour-grid";
import { boardFromV2, publicDaySchema } from "@/lib/quarter/client/day";
import { proposeHours, proposeQuarters, quarterEditRefusal } from "@/lib/quarter/client/edit";
import { commandFor, type DraftGeneration, type DraftSnapshot } from "@/lib/quarter/client/draft-types";
import { scheduledIntervalHeadcounts } from "@/lib/board/headcounts";

const date = "2040-10-12", start = +chicagoHourStart(date, 11), iso = (minute: number) => new Date(start + minute * 60_000).toISOString();
const scope = { managerId: "synthetic-manager", board: "caja" as const, date };
const empty: DraftSnapshot = { head: null, generations: [], submissions: [], archives: [], originals: [], warnings: [] };
function day() {
  return publicDaySchema.parse({ schemaVersion: 2, databaseEpoch: "epoch", worldRevision: "10", phase: "active", capabilitySha256: "a".repeat(64), board: "caja", date,
    employees: [{ id: "person", firstName: "Synthetic", lastName: "Quarter" }],
    stations: [{ id: "green1", label: "Green", color: "green", maxConcurrent: 1, sortOrder: 1, shortCode: "G1" }],
    sources: [{ shiftId: "source", employeeId: "person", date, board: "caja", sourcePosition: "Caja", startAt: iso(0), endAt: iso(60), supersededAt: null, boardRemoved: false }],
    hours: [{ shiftId: "source", hourStart: iso(0), revision: "2", intervals: [{ startAt: iso(0), endAt: iso(60), state: "erased", stationId: null, seatNumber: null, provenance: { kind: "v2", paintHourId: "hour", segmentId: "segment" } }] }],
    coverDisplay: { version: 1, tracks: [], unavailable: [] },
  });
}
function retained(g: DraftGeneration): DraftSnapshot {
  return { ...empty, head: { ...scope, localRevision: "1", generationId: g.generationId, state: "outstanding", pendingRequestId: null }, generations: [g] };
}
describe("Q1 exact-quarter private proposals", () => {
  it("replaces only the chosen quarter and retains sibling IDs, first dirty time and original expectations", () => {
    const view = day(), first = proposeQuarters(scope, empty, view, [{ shiftId: "source", hour: 11, minute: 15, action: { action: "station", stationId: "green1" } }], iso(0)).proposal;
    const original = JSON.stringify(first), snap = retained(first);
    const second = proposeQuarters(scope, snap, view, [{ shiftId: "source", hour: 11, minute: 30, action: { action: "erase" } }], iso(1)).proposal;
    expect(second.envelope.intents[0]).toEqual(first.envelope.intents[0]);
    expect(second.envelope.firstDirtyAt).toBe(iso(0));
    expect(second.envelope.episodeId).toBe(first.envelope.episodeId);
    view.worldRevision = "11"; view.hours[0].revision = "3";
    const third = proposeQuarters(scope, retained(second), view, [{ shiftId: "source", hour: 11, minute: 15, action: { action: "erase" } }]).proposal;
    expect(third.envelope.intents.map(i => i.hour.revision)).toEqual(["2", "2"]);
    expect(third.envelope.baseWorldRevision).toBe("10");
    expect(JSON.stringify(first)).toBe(original);
    const command = commandFor(third, view.capabilitySha256);
    expect(command.intents.map(i => i.quarter).sort()).toEqual(["11:15", "11:30"]);
    expect(command.hours).toHaveLength(1);
  });
  it("expands a private hour without losing its other quarters or mutating the submitted generation", () => {
    const view = day();
    const hour = proposeHours(scope, empty, view, [{ shiftId: "source", hour: 11, action: { action: "station", stationId: "green1" } }]).proposal;
    const original = JSON.stringify(hour), snap = retained(hour); snap.head!.pendingRequestId = "in-flight";
    const quarter = proposeQuarters(scope, snap, view, [{ shiftId: "source", hour: 11, minute: 15, action: { action: "erase" } }]).proposal;
    expect(quarter.envelope.pendingRequestId).toBe("in-flight");
    expect(quarter.envelope.intents).toHaveLength(4);
    expect(quarter.envelope.intents.filter(i => i.intent.action === "station").map(i => i.intent.quarter)).toEqual(["11:00", "11:30", "11:45"]);
    expect(JSON.stringify(hour)).toBe(original);
    expect(() => proposeHours(scope, retained(quarter), view, [{ shiftId: "source", hour: 11, action: { action: "erase" } }])).toThrow("QUARTER_DRAFT_REVIEW_ONLY");
  });
  it("clips partial shifts, refuses off/obligated quarters and leaves the input intact on a refused drag", () => {
    const view = day(); view.sources[0].endAt = iso(20);
    expect(quarterEditRefusal(view, "source", 11, 15)).toBeNull();
    expect(quarterEditRefusal(view, "source", 11, 30)).toBe("SOURCE_NOT_AVAILABLE");
    const original = JSON.stringify(empty);
    expect(() => proposeQuarters(scope, empty, view, [
      { shiftId: "source", hour: 11, minute: 15, action: { action: "erase" } },
      { shiftId: "source", hour: 11, minute: 30, action: { action: "erase" } },
    ])).toThrow("SOURCE_NOT_AVAILABLE");
    expect(JSON.stringify(empty)).toBe(original);
    view.overlays = [{ id: "saved", kind: "remove", employeeId: "person", partnerEmployeeId: null, stationId: "green1", fromStationId: null, startAt: iso(15), endAt: iso(30), managerId: "manager", managerName: "Synthetic", cancelledAt: null, endReason: null }];
    expect(quarterEditRefusal(view, "source", 11, 0)).toBeNull();
    expect(quarterEditRefusal(view, "source", 11, 15)).toBe("QUARTER_HAS_OBLIGATION");
  });
  it("deduplicates split shifts, counts partial scheduled minutes and subtracts removals without adding auxiliary covers", () => {
    const view = day(); view.sources[0].endAt = iso(20);
    view.sources.push({ ...view.sources[0], shiftId: "second", startAt: iso(20), endAt: iso(30) });
    view.sources.push({ ...view.sources[0], shiftId: "backup", employeeId: "backup", sourcePosition: "REFUERZO", startAt: iso(0), endAt: iso(60), board: "other" });
    view.employees.push({ id: "backup", firstName: "Backup", lastName: "Synthetic" });
    const board = boardFromV2(view), slots = [0, 15, 30, 45].map(minute => ({ hour: 11, minute, minutes: 15 }));
    expect(scheduledIntervalHeadcounts(board, slots)).toEqual([1, 1, 0, 0]);
    board.overlays = [{ id: "removal", kind: "remove", employeeId: "person", partnerEmployeeId: null, stationId: "green1", fromStationId: null, startAt: iso(15), endAt: iso(30), managerId: "m", managerName: "Synthetic", cancelledAt: null, endReason: null }];
    expect(scheduledIntervalHeadcounts(board, slots, new Date(iso(0)))).toEqual([1, 0, 0, 0]);
    board.shifts[0].endAt = iso(0.5); board.shifts = board.shifts.slice(0, 1);
    expect(scheduledIntervalHeadcounts(board, slots)).toEqual([0, 0, 0, 0]);
  });
});
