import { describe, expect, it } from "vitest";
import { isHourInShift, shiftOverlapMinutes } from "@/lib/rules/shift-window";
import { chicagoHourEnd, chicagoHourStart } from "@/lib/hour-grid";
import { chicagoDateTime } from "@/lib/time";
import { availableShiftsForHour } from "@/components/board/board-helpers";
import type { ShiftDto } from "@/components/board/types";

const D = "2030-05-06";
const at = (clock: string) => chicagoDateTime(D, clock);
const hour = (h: number) => [chicagoHourStart(D, h), chicagoHourEnd(D, h)] as const;

describe("A19: one overlap rule for partial hours", () => {
  it("a :30 start is on-shift in its partial hour and counts 30 minutes", () => {
    const [hs, he] = hour(9);
    expect(isHourInShift(hs, at("9:30 am"), at("1:00 pm"), he)).toBe(true);
    expect(shiftOverlapMinutes(hs, he, at("9:30 am"), at("1:00 pm"))).toBe(30);
  });

  it("a :30 end is on-shift in its partial hour and counts 30 minutes", () => {
    const [hs, he] = hour(16);
    expect(isHourInShift(hs, at("8:00 am"), at("4:30 pm"), he)).toBe(true);
    expect(shiftOverlapMinutes(hs, he, at("8:00 am"), at("4:30 pm"))).toBe(30);
  });

  it("back-to-back shifts (end = next start) do not overlap the next hour", () => {
    const [hs, he] = hour(12);
    expect(isHourInShift(hs, at("8:00 am"), at("12:00 pm"), he)).toBe(false);
    expect(shiftOverlapMinutes(hs, he, at("8:00 am"), at("12:00 pm"))).toBe(0);
    expect(isHourInShift(hs, at("12:00 pm"), at("4:00 pm"), he)).toBe(true);
  });

  it("whole-hour shifts are unchanged: inclusive start, exclusive end, 60 minutes", () => {
    const start = at("8:00 am");
    const end = at("5:00 pm");
    expect(isHourInShift(at("8:00 am"), start, end)).toBe(true);
    expect(isHourInShift(at("4:00 pm"), start, end)).toBe(true);
    expect(isHourInShift(at("5:00 pm"), start, end)).toBe(false);
    expect(isHourInShift(at("7:00 am"), start, end)).toBe(false);
    const [hs, he] = hour(10);
    expect(shiftOverlapMinutes(hs, he, start, end)).toBe(60);
  });

  it("the people list offers a :30 starter in hour 9", () => {
    const shift: ShiftDto = {
      id: "s-930",
      date: D,
      startAt: at("9:30 am").toISOString(),
      endAt: at("1:00 pm").toISOString(),
      sourcePosition: "Caja - Regular",
      board: "caja",
      employee: { id: "e", externalId: "5001", firstName: "Iris", lastName: "Demo", email: null, abilities: [] },
      assignments: [],
    };
    expect(availableShiftsForHour([shift], D, 9).map((s) => s.id)).toEqual(["s-930"]);
    expect(availableShiftsForHour([shift], D, 13)).toEqual([]);
  });
});
