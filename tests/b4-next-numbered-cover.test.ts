import { describe, expect, it } from "vitest";
import { numberedSeatCover } from "@/lib/breaks/covers";
import { PAINT_FAMILIES } from "@/lib/assignments/paint-families";
import { isDefaultMandatory } from "@/lib/mandatory";
import { buildDaySlices } from "@/lib/slices/day-slices";
import { chicagoDateTime } from "@/lib/time";

const date = "2036-06-04";
const at = (time: string) => chicagoDateTime(date, time);
const pairs = Object.values(PAINT_FAMILIES).filter(pair => isDefaultMandatory(pair[0])).map(pair => [pair[0], pair[1]] as [string, string]);
function world(one: string, two: string) {
  const board = one.startsWith("pdf_") ? "cocina" as const : "caja" as const;
  return {
    date, board, employeeId: "asker", startAt: at("2:00 pm"), endAt: at("2:30 pm"),
    shifts: ["asker", "cover"].map(id => ({ id, employeeId: id, board, startAt: at("8:00 am"), endAt: at("8:00 pm"), superseded: false, boardRemoved: false })),
    paints: [{ employeeId: "asker", shiftId: "asker", stationId: one, hourStart: at("2:00 pm") }, { employeeId: "cover", shiftId: "cover", stationId: two, hourStart: at("2:00 pm") }],
    starStationIds: [one], abilities: [], names: new Map([["asker", "Asker"], ["cover", "Cover"]]),
    breaks: [] as Parameters<typeof numberedSeatCover>[0]["breaks"],
    overlays: [] as NonNullable<Parameters<typeof numberedSeatCover>[0]["overlays"]>,
  };
}

describe("numbered seats reuse booked cover without the five-minute flag", () => {
  it.each(pairs)("covers %s from %s and restores the effective seat", (one, two) => {
    const input = world(one, two);
    expect(numberedSeatCover(input)?.employeeId).toBe("cover");
    const day = buildDaySlices({ ...input, now: input.startAt, stations: [one, two].map(id => ({ id })), breaks: [{ employeeId: "asker", shiftId: "asker", board: input.board, startAt: input.startAt, endAt: input.endAt, status: "booked", coverEmployeeId: "cover", auto: false }] });
    expect(day.slices.find(s => s.start.getTime() === at("2:00 pm").getTime())?.seats).toContainEqual({ stationId: one, employeeId: "cover", source: "cover" });
    expect(day.slices.find(s => s.start.getTime() === at("2:30 pm").getTime())?.seats).toContainEqual({ stationId: two, employeeId: "cover", source: "paint" });
  });
  it("refuses seat 3, other board, short window, forbidden, mandatory 2 and cover conflicts", () => {
    for (const mutate of [
      (x: ReturnType<typeof world>) => { x.paints[1].stationId = "pdf_tq3r"; },
      (x: ReturnType<typeof world>) => { x.shifts[1].board = "caja"; },
      (x: ReturnType<typeof world>) => { x.shifts[1].endAt = at("2:15 pm"); },
      (x: ReturnType<typeof world>) => { x.starStationIds.push("pdf_tq2r"); },
    ]) {
      const input = world("pdf_tq1r", "pdf_tq2r"); mutate(input); expect(numberedSeatCover(input)).toBeNull();
    }
    const input = world("pdf_tq1r", "pdf_tq2r");
    expect(numberedSeatCover({ ...input, abilities: [{ employeeId: "cover", stationId: "pdf_tq1r", level: "forbidden" }] })).toBeNull();
    expect(numberedSeatCover({ ...input, breaks: [{ employeeId: "third", shiftId: "third", board: "cocina", startAt: input.startAt, endAt: input.endAt, status: "booked", coverEmployeeId: "cover" }] })).toBeNull();
    expect(numberedSeatCover({ ...input, breaks: [{ employeeId: "cover", shiftId: "cover", board: "cocina", startAt: input.startAt, endAt: input.endAt, status: "booked" }] })).toBeNull();
  });
  it("requires the 2 throughout the window, including the pre-11 portion", () => {
    const input = world("pdf_tq1r", "pdf_tq2r");
    input.startAt = at("10:45 am"); input.endAt = at("11:15 am");
    input.paints = input.paints.flatMap(p => [{ ...p, hourStart: at("10:00 am") }, { ...p, hourStart: at("11:00 am") }]);
    expect(numberedSeatCover(input)?.employeeId).toBe("cover");
    input.paints.find(p => p.employeeId === "cover" && p.hourStart.getTime() === at("10:00 am").getTime())!.stationId = "pdf_tq3r";
    expect(numberedSeatCover(input)).toBeNull();
  });
  it("projects a requester Switch and a cover Switch without rewriting paint", () => {
    const input = world("pdf_tq1r", "pdf_tq2r");
    input.paints[0].stationId = "pdf_tq3r";
    input.paints[1].stationId = "open";
    input.overlays = [
      { id: "one", kind: "switch", employeeId: "asker", stationId: "pdf_tq1r", startAt: input.startAt, endAt: input.endAt },
      { id: "two", kind: "switch", employeeId: "cover", stationId: "pdf_tq2r", startAt: input.startAt, endAt: input.endAt },
    ];
    expect(numberedSeatCover(input)?.employeeId).toBe("cover");
  });
});
