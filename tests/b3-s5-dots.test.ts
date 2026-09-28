/**
 * B3 S5: owner eligibility dots for an open hour with a mandatory gap.
 */
import { describe, expect, it } from "vitest";
import { chicagoHourStart } from "@/lib/hour-grid";
import {
  MANDATORY_STATIONS,
  eligibilityCellKind,
  eligibilityDots,
  uncoveredMandatory,
} from "@/lib/mandatory";

const date = "2034-11-06";
const hours = [10, 11, 12];

function person(abilities?: { stationId: string; level: string }[] | null) {
  return {
    id: "ada",
    date,
    startAt: chicagoHourStart(date, 9).toISOString(),
    endAt: chicagoHourStart(date, 17).toISOString(),
    assignments: [] as { stationId: string; hourStart: string }[],
    employee: { abilities },
  };
}

function gapsFor(levelled: ReturnType<typeof person>) {
  return uncoveredMandatory({
    stationIds: MANDATORY_STATIONS,
    hours,
    date,
    shifts: [levelled],
  });
}

describe("B3 S5 eligibility dots", () => {
  it("E1 bien, fuerte and a missing row are full, entrenando is dim, no and hour 10 are empty", () => {
    const open = person([]);
    const gaps = gapsFor(open);
    expect(gaps.some((gap) => gap.hour === 10)).toBe(false);
    expect(gaps.filter((gap) => gap.hour === 12).map((gap) => gap.stationId)).toEqual([
      "pdf_tq1r",
      "pdf_tf1r",
      "pdf_pr1e",
      "pdf_br1a",
    ]);

    const at = (level: string | null) => eligibilityDots({
      gaps,
      shift: person(level == null ? [] : [{ stationId: "pdf_tq1r", level }]),
      hour: 12,
      kind: "open",
    }).find((dot) => dot.stationId === "pdf_tq1r");

    expect(at("ok")).toEqual({ stationId: "pdf_tq1r", level: "ok" });
    expect(at("preferred")).toEqual({ stationId: "pdf_tq1r", level: "preferred" });
    expect(at(null)).toEqual({ stationId: "pdf_tq1r", level: "ok" });
    expect(at("training")).toEqual({ stationId: "pdf_tq1r", level: "training" });
    expect(at("forbidden")).toBeUndefined();

    expect(eligibilityDots({
      gaps,
      shift: person([{ stationId: "pdf_tq1r", level: "preferred" }]),
      hour: 10,
      kind: "open",
    })).toEqual([]);

    const ordered = eligibilityDots({
      gaps,
      shift: person([
        { stationId: "pdf_pr1e", level: "forbidden" },
        { stationId: "pdf_tf1r", level: "training" },
        { stationId: "pdf_tq1r", level: "preferred" },
      ]),
      hour: 12,
      kind: "open",
    });
    expect(ordered).toEqual([
      { stationId: "pdf_tq1r", level: "preferred" },
      { stationId: "pdf_tf1r", level: "training" },
      { stationId: "pdf_br1a", level: "ok" },
    ]);
  });

  it("E1 two gaps follow day.stations order when the mandatory list is reversed", () => {
    const boardOrder = ["pdf_tf1r", "pdf_guia", "pdf_pr1e", "pdf_tq1r"];
    const reversed = [...MANDATORY_STATIONS].reverse();
    const filler = {
      ...person([]),
      id: "filler",
      assignments: [{ stationId: "pdf_tq1r", hourStart: chicagoHourStart(date, 12).toISOString() }],
    };
    const gaps = uncoveredMandatory({
      stationIds: reversed,
      boardOrder,
      hours,
      date,
      shifts: [filler],
    });
    expect(gaps.filter((gap) => gap.hour === 12).map((gap) => gap.stationId)).toEqual([
      "pdf_tf1r",
      "pdf_pr1e",
      "pdf_br1a",
    ]);

    const ordered = eligibilityDots({
      gaps,
      shift: person([
        { stationId: "pdf_pr1e", level: "preferred" },
        { stationId: "pdf_tf1r", level: "training" },
        { stationId: "pdf_tq1r", level: "preferred" },
      ]),
      hour: 12,
      kind: "open",
    });
    expect(ordered).toEqual([
      { stationId: "pdf_tf1r", level: "training" },
      { stationId: "pdf_pr1e", level: "preferred" },
      { stationId: "pdf_br1a", level: "ok" },
    ]);
  });

  it("E2 seated and off cells and an absent abilities array return nothing", () => {
    const gaps = gapsFor(person([]));
    const present = person([{ stationId: "pdf_tq1r", level: "preferred" }]);
    expect(eligibilityDots({ gaps, shift: present, hour: 12, kind: "seated" })).toEqual([]);
    expect(eligibilityDots({ gaps, shift: present, hour: 12, kind: "off" })).toEqual([]);
    expect(eligibilityDots({ gaps, shift: person(undefined), hour: 12, kind: "open" })).toEqual([]);
    expect(eligibilityDots({ gaps, shift: person(null), hour: 12, kind: "open" })).toEqual([]);

    expect(eligibilityCellKind("open", { stationId: "pdf_guia" })).toBe("seated");
    expect(eligibilityCellKind("open", { stationId: null, family: "taquero" })).toBe("seated");
    expect(eligibilityCellKind("open", undefined)).toBe("open");
    expect(eligibilityCellKind("seated", { stationId: null })).toBe("open");
    expect(eligibilityCellKind("off", { stationId: "pdf_tq1r" })).toBe("off");

    const filled = eligibilityCellKind("open", { stationId: "pdf_guia" });
    expect(eligibilityDots({ gaps, shift: person([]), hour: 12, kind: filled })).toEqual([]);
  });
});
