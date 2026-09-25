import { describe, expect, it } from "vitest";
import {
  formatDateBarLabel,
  nextImportedDate,
  prevImportedDate,
  resolveTodayInList,
} from "./date-format";

describe("formatDateBarLabel", () => {
  it("reads vie 25 sep for a Friday in Spanish, no comma", () => {
    // 2026-09-25 is a Friday.
    expect(formatDateBarLabel("2026-09-25", "es")).toBe("vie 25 sep");
  });

  it("reads the English equivalent in the same weekday-day-month order", () => {
    expect(formatDateBarLabel("2026-09-25", "en")).toBe("Fri 25 Sep");
  });

  it("does not shift a day at a UTC/Chicago boundary (pure calendar-part math)", () => {
    // A naive `new Date("2026-01-01")` + local getters can read as the prior
    // evening in Chicago; this must stay 2026-01-01 (Thursday) regardless of
    // the runner's local timezone.
    expect(formatDateBarLabel("2026-01-01", "en")).toBe("Thu 1 Jan");
  });

  it("covers every weekday and a December label", () => {
    expect(formatDateBarLabel("2026-09-20", "es")).toBe("dom 20 sep"); // Sun
    expect(formatDateBarLabel("2026-09-21", "es")).toBe("lun 21 sep"); // Mon
    expect(formatDateBarLabel("2026-12-31", "es")).toBe("jue 31 dic"); // Thu
  });
});

const WEEK = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];

describe("prevImportedDate / nextImportedDate (D1: never leave the imported range)", () => {
  it("steps back and forward within the list", () => {
    expect(prevImportedDate(WEEK, "2026-09-22")).toBe("2026-09-21");
    expect(nextImportedDate(WEEK, "2026-09-22")).toBe("2026-09-23");
  });

  it("is a no-op at the start of the list — never walks past the beginning", () => {
    expect(prevImportedDate(WEEK, WEEK[0])).toBeNull();
  });

  it("is a no-op at the end of the list — never walks past the end", () => {
    expect(nextImportedDate(WEEK, WEEK[WEEK.length - 1])).toBeNull();
  });

  it("is null for a date that isn't in the list at all", () => {
    expect(prevImportedDate(WEEK, "2026-01-01")).toBeNull();
    expect(nextImportedDate(WEEK, "2026-01-01")).toBeNull();
  });

  it("is null on an empty list", () => {
    expect(prevImportedDate([], "2026-09-22")).toBeNull();
    expect(nextImportedDate([], "2026-09-22")).toBeNull();
  });
});

describe("resolveTodayInList (D2: Hoy targets Chicago-today, only if imported)", () => {
  it("returns today when it is in the imported list", () => {
    expect(resolveTodayInList(WEEK, "2026-09-22")).toBe("2026-09-22");
  });

  it("returns null — not the nearest date — when today isn't imported", () => {
    expect(resolveTodayInList(WEEK, "2026-09-30")).toBeNull();
  });
});
