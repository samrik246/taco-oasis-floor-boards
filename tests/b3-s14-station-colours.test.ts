import { describe, expect, it } from "vitest";
import { stationColorClass } from "@/components/board/board-helpers";
import { STATION_COLORS } from "@/lib/admin/validate";
import { markBorderClass, markFillClass } from "@/lib/selection-mark";
import { stationSolidClass } from "@/lib/schedule/station-codes";
import {
  applyS14StationColours,
  S14_COLOUR_MOVES,
  type StationColourRow,
  type StationColourStore,
} from "@/lib/s14-station-colours";
import { ALL_STATIONS } from "@/lib/stations";

const CELL_FALLBACK = "bg-neutral-100 border-neutral-600 text-neutral-900";
const CHIP_FALLBACK = "bg-neutral-300 text-neutral-950";
const BORDER_FALLBACK = "border-neutral-600";
const FILL_FALLBACK = "bg-neutral-600";

const WHITE_TEXT = new Set([
  "gold",
  "red",
  "maroon",
  "brown",
  "deep-orange",
  "dark-orange",
  "green",
  "dark-green",
  "sky",
  "dark-sky",
  "deep-sky",
  "dark-pink",
  "violet",
]);

function memory(rows: StationColourRow[]): StationColourStore & { rows: StationColourRow[]; writes: { id: string; color: string }[] } {
  const store = {
    rows: rows.map((row) => ({ ...row })),
    writes: [] as { id: string; color: string }[],
    station: {
      async findMany(): Promise<StationColourRow[]> {
        return store.rows.map((row) => ({ ...row }));
      },
      async updateMany(args: { where: { id: string; color: string }; data: { color: string } }) {
        const keys = Object.keys(args.data);
        if (keys.length !== 1 || keys[0] !== "color") {
          throw new Error(`colour script wrote ${keys.join(",")}`);
        }
        let count = 0;
        for (const row of store.rows) {
          if (row.id === args.where.id && row.color === args.where.color) {
            row.color = args.data.color;
            count += 1;
          }
        }
        store.writes.push({ id: args.where.id, color: args.data.color });
        return { count };
      },
    },
  };
  return store;
}

describe("S14 station colours", () => {
  it("gives every colour name a cell, a chip, a mark, and an admin entry", () => {
    for (const color of STATION_COLORS) {
      expect(stationColorClass(color)).not.toBe(CELL_FALLBACK);
      expect(stationSolidClass(color)).not.toBe(CHIP_FALLBACK);
      expect(markBorderClass(color)).not.toBe(BORDER_FALLBACK);
      expect(markFillClass(color)).not.toBe(FILL_FALLBACK);
    }
  });

  it("puts every station on a mapped colour, with one step per board and teal unused", () => {
    const allowed = new Set<string>(STATION_COLORS);
    for (const board of ["caja", "cocina"] as const) {
      const colors = ALL_STATIONS.filter((station) => station.board === board).map((station) => station.color);
      expect(new Set(colors).size).toBe(colors.length);
      for (const color of colors) expect(allowed.has(color)).toBe(true);
    }
    expect(ALL_STATIONS.some((station) => station.color === "teal")).toBe(false);
    expect(allowed.has("teal")).toBe(true);
  });

  it("uses dark text on a light step and white text on a darker step", () => {
    for (const station of ALL_STATIONS) {
      const painted = stationColorClass(station.color);
      if (WHITE_TEXT.has(station.color)) expect(painted).toContain("text-white");
      else expect(painted).not.toContain("text-white");
    }
    expect(ALL_STATIONS.find((station) => station.id === "pdf_crne")?.color).toBe("light-orange");
    expect(ALL_STATIONS.find((station) => station.id === "pdf_rlno")?.color).toBe("deep-orange");
    expect(ALL_STATIONS.find((station) => station.id === "pdf_cyrl")?.color).toBe("dark-orange");
    expect(stationColorClass("dark-orange")).toBe("bg-orange-800 border-orange-950 text-white");
    expect(stationSolidClass("dark-orange")).toBe("bg-orange-900 text-white");
    expect(ALL_STATIONS.find((station) => station.id === "pdf_br1a")?.color).toBe("light-brown");
    expect(ALL_STATIONS.find((station) => station.id === "pdf_br2a")?.color).toBe("brown");
    expect(ALL_STATIONS.find((station) => station.id === "mesero")?.color).toBe("orange");
  });

  it("updates an old seed colour, leaves a manager colour, and changes nothing on the second run", async () => {
    const store = memory([
      { id: "pdf_crne", color: "brown" },
      { id: "pdf_rlno", color: "navy" },
      { id: "pdf_guia", color: "white" },
      { id: "mesero", color: "orange" },
    ]);
    const first = await applyS14StationColours(store);
    expect(first).toMatchObject({ before: 1, updated: 1, kept: 1, already: 1, missing: 18, after: 0 });
    expect(store.rows.find((row) => row.id === "pdf_crne")?.color).toBe("light-orange");
    expect(store.rows.find((row) => row.id === "pdf_rlno")?.color).toBe("navy");
    expect(store.rows.find((row) => row.id === "pdf_guia")?.color).toBe("white");
    expect(store.rows.find((row) => row.id === "mesero")?.color).toBe("orange");
    expect(store.writes).toEqual([{ id: "pdf_crne", color: "light-orange" }]);
    expect(store.rows).toHaveLength(4);

    const second = await applyS14StationColours(store);
    expect(second.updated).toBe(0);
    expect(second.before).toBe(0);
    expect(second.after).toBe(0);
    expect(store.writes).toHaveLength(1);
  });

  it("names a move only where the 2374986 seed colour changes", () => {
    const moved = new Set(S14_COLOUR_MOVES.map((move) => move.id));
    expect(moved.size).toBe(S14_COLOUR_MOVES.length);
    for (const move of S14_COLOUR_MOVES) {
      expect(move.from).not.toBe(move.to);
      expect(ALL_STATIONS.find((station) => station.id === move.id)?.color).toBe(move.to);
    }
    const unchanged = ["yellow", "purple1", "blue", "multi", "mesero", "pdf_rngn", "pdf_tf1r", "pdf_tq2r", "pdf_tq3r", "pdf_pr2e", "pdf_pstl"];
    for (const id of unchanged) expect(moved.has(id)).toBe(false);
  });
});
