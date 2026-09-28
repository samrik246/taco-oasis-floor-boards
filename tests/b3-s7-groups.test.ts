/**
 * B3 S7: palette blocks and Puesto rows share one family grouping.
 */
import { describe, expect, it } from "vitest";
import {
  PAINT_FAMILIES,
  paletteSlots,
  type PaintFamily,
} from "@/lib/assignments/paint-families";
import { comparePintarRows } from "@/lib/schedule/build-schedule";
import { CAJA_STATIONS, COCINA_STATIONS } from "@/lib/stations";

function slotIds(stations: readonly { id: string; sortOrder: number }[]): string[] {
  return paletteSlots(stations).map((slot) =>
    slot.kind === "family" ? `family:${slot.family}` : slot.id,
  );
}

function expectFamilyBlock(
  ids: readonly string[],
  family: PaintFamily,
) {
  const members = [...PAINT_FAMILIES[family]];
  const start = ids.indexOf(`family:${family}`);
  expect(start, family).toBeGreaterThanOrEqual(0);
  expect(ids.slice(start, start + 1 + members.length)).toEqual([
    `family:${family}`,
    ...members,
  ]);
  expect(ids.filter((id) => id === `family:${family}`)).toEqual([`family:${family}`]);
  for (const member of members) {
    expect(ids.filter((id) => id === member)).toEqual([member]);
  }
}

describe("S7 palette groups", () => {
  it("puts every complete family in one number-ordered block", () => {
    const caja = slotIds(CAJA_STATIONS);
    for (const family of ["green", "purple", "nieves", "yellow"] as const) {
      expectFamilyBlock(caja, family);
    }
    const cocina = slotIds(COCINA_STATIONS);
    for (const family of [
      "preparacion",
      "tortillaFreidora",
      "taquero",
      "birria",
      "trastes",
    ] as const) {
      expectFamilyBlock(cocina, family);
    }
  });

  it("pulls interleaved seed members to member 1", () => {
    const ids = slotIds(COCINA_STATIONS);
    const prep = ids.indexOf("family:preparacion");
    expect(ids.slice(prep, prep + 4)).toEqual([
      "family:preparacion",
      "pdf_pr1e",
      "pdf_pr2e",
      "pdf_pr3e",
    ]);
    const trastes = ids.indexOf("family:trastes");
    expect(ids.slice(trastes, trastes + 5)).toEqual([
      "family:trastes",
      "pdf_tsrea",
      "pdf_tsr2",
      "pdf_tsr3",
      "pdf_tsr4",
    ]);
    expect(ids.indexOf("pdf_crne")).toBeLessThan(prep);
    expect(ids.indexOf("pdf_pr3e")).toBe(prep + 3);
  });

  it("leaves an incomplete family in seed order without a group button", () => {
    const ids = slotIds(CAJA_STATIONS.filter((station) => station.id !== "green2"));
    expect(ids).not.toContain("family:green");
    expect(ids).toContain("green1");
    expect(ids.filter((id) => id === "green1")).toEqual(["green1"]);
    expectFamilyBlock(ids, "yellow");
  });
});

describe("S7 puesto row groups", () => {
  it("sorts an interleaved seed order into adjacent number order", () => {
    const order = new Map(COCINA_STATIONS.map((station) => [station.id, station.sortOrder]));
    const row = (stationId: string) => ({
      name: stationId,
      employeeId: stationId,
      startAt: "2035-04-16T14:00:00.000Z",
      shiftId: stationId,
      stationId,
    });
    const stations = [
      "pdf_pr3e",
      "pdf_tsr2",
      "pdf_crne",
      "pdf_pr1e",
      "pdf_pr2e",
      "pdf_tsrea",
      "pdf_tsr4",
      "pdf_tsr3",
    ].map(row).sort((a, b) => comparePintarRows(a, b, "position", order))
      .map((item) => item.stationId);
    const prepAt = stations.indexOf("pdf_pr1e");
    expect(stations.slice(prepAt, prepAt + 3)).toEqual(["pdf_pr1e", "pdf_pr2e", "pdf_pr3e"]);
    const trastesAt = stations.indexOf("pdf_tsrea");
    expect(stations.slice(trastesAt, trastesAt + 4)).toEqual([
      "pdf_tsrea",
      "pdf_tsr2",
      "pdf_tsr3",
      "pdf_tsr4",
    ]);
    expect(stations.indexOf("pdf_crne")).toBeLessThan(prepAt);
  });
});
