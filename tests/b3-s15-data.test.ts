import { describe, expect, it } from "vitest";
import { cocinaAbilityColumns } from "@/lib/abilities/levels";
import { PAINT_FAMILIES } from "@/lib/assignments/paint-families";
import { KITCHEN_LOAD_STATIONS } from "@/lib/load-stations";
import {
  MANDATORY_GAP_START,
  MANDATORY_STATIONS_BY_BOARD,
  isDefaultMandatory,
  uncoveredMandatory,
} from "@/lib/mandatory";
import { setMandatoryMark } from "@/lib/mandatory-store";
import { chicagoHourStart } from "@/lib/hour-grid";
import {
  CARNE_RELLENO_SETTING,
  CARNE_RELLENO_STATION,
  CarneRellenoConflict,
  applyCarneRelleno,
  type CarneRellenoSetting,
  type CarneRellenoStation,
} from "@/lib/s15-carne-relleno";
import { wallTilesForHour } from "@/lib/wall-stations";

type StationRow = CarneRellenoStation & { note?: string };
type SettingRow = CarneRellenoSetting & { note?: string };

type MemoryTx = {
  station: {
    findUnique(args: { where: { id: string } }): Promise<StationRow | null>;
    create(args: { data: CarneRellenoStation }): Promise<CarneRellenoStation>;
  };
  abilityColumnSetting: {
    findUnique(args: { where: { key: string } }): Promise<SettingRow | null>;
    create(args: { data: CarneRellenoSetting }): Promise<CarneRellenoSetting>;
  };
};

type MemoryDb = MemoryTx & {
  state: { stations: StationRow[]; settings: SettingRow[]; writes: number };
  $transaction<T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T>;
};

function memory(stations: StationRow[], settings: SettingRow[]): MemoryDb {
  const state: MemoryDb["state"] = {
    stations: stations.map((row) => ({ ...row })),
    settings: settings.map((row) => ({ ...row })),
    writes: 0,
  };
  const api: MemoryDb = {
    state,
    async $transaction<T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
      const snap = {
        stations: state.stations.map((row) => ({ ...row })),
        settings: state.settings.map((row) => ({ ...row })),
        writes: state.writes,
      };
      try {
        return await fn(api);
      } catch (error) {
        state.stations = snap.stations;
        state.settings = snap.settings;
        state.writes = snap.writes;
        throw error;
      }
    },
    station: {
      async findUnique(args: { where: { id: string } }) {
        return state.stations.find((row) => row.id === args.where.id) ?? null;
      },
      async create(args: { data: CarneRellenoStation }) {
        if (args.data.id !== CARNE_RELLENO_STATION.id) {
          throw new Error(`unexpected station write ${args.data.id}`);
        }
        state.stations.push({ ...args.data });
        state.writes += 1;
        return args.data;
      },
    },
    abilityColumnSetting: {
      async findUnique(args: { where: { key: string } }) {
        return state.settings.find((row) => row.key === args.where.key) ?? null;
      },
      async create(args: { data: CarneRellenoSetting }) {
        if (args.data.key !== CARNE_RELLENO_SETTING.key) {
          throw new Error(`unexpected setting write ${args.data.key}`);
        }
        state.settings.push({ ...args.data });
        state.writes += 1;
        return args.data;
      },
    },
  };
  return api;
}

const otherStation: StationRow = {
  id: "pdf_crne",
  board: "cocina",
  label: "Carne",
  color: "light-orange",
  maxConcurrent: 1,
  sortOrder: 0,
  priority: null,
  shortCode: "CRNE",
  note: "leave",
};

describe("S15 Carne y Relleno script", () => {
  it("inserts the station and the hidden column, then writes nothing on the second run", async () => {
    const db = memory([otherStation], []);
    const first = await applyCarneRelleno(db);
    expect(first.station).toBe("inserted");
    expect(first.setting).toBe("inserted");
    expect(first.conflict).toBe("none");
    expect(first.station_after).toEqual(CARNE_RELLENO_STATION);
    expect(first.setting_after).toEqual(CARNE_RELLENO_SETTING);
    expect(db.state.writes).toBe(2);
    expect(db.state.stations.filter((row) => row.id === "pdf_cyrl")).toHaveLength(1);
    expect(db.state.stations.find((row) => row.id === "pdf_crne")).toEqual(otherStation);

    const writes = db.state.writes;
    const second = await applyCarneRelleno(db);
    expect(second.station).toBe("already");
    expect(second.setting).toBe("already");
    expect(second.conflict).toBe("none");
    expect(db.state.writes).toBe(writes);
    expect(db.state.stations).toHaveLength(2);
    expect(db.state.settings).toEqual([CARNE_RELLENO_SETTING]);
  });

  it("rolls back when a stored field differs and leaves every other row", async () => {
    const wrong = { ...CARNE_RELLENO_STATION, color: "navy" };
    const db = memory([otherStation, wrong], []);
    try {
      await applyCarneRelleno(db);
      throw new Error("expected a conflict");
    } catch (error) {
      if (error instanceof Error && error.message === "expected a conflict") throw error;
      expect(error).toBeInstanceOf(CarneRellenoConflict);
      if (error instanceof CarneRellenoConflict) {
        expect(error.report.station).toBe("conflict");
        expect(error.report.setting).toBe("rolled_back");
        expect(error.report.conflict).toBe("station.color");
        expect(error.report.station_after?.color).toBe("navy");
        expect(error.report.setting_after).toBeNull();
      }
    }
    expect(db.state.writes).toBe(0);
    expect(db.state.settings).toEqual([]);
    expect(db.state.stations.find((row) => row.id === "pdf_cyrl")?.color).toBe("navy");
    expect(db.state.stations.find((row) => row.id === "pdf_crne")).toEqual(otherStation);
  });
});

describe("S15 mandatory Guía and Manager", () => {
  const date = "2031-04-06";

  it("appends Guía and Manager and counts them from 11:00", async () => {
    expect(MANDATORY_STATIONS_BY_BOARD.cocina.slice(0, 4)).toEqual([
      "pdf_tq1r", "pdf_tf1r", "pdf_pr1e", "pdf_br1a",
    ]);
    expect(MANDATORY_STATIONS_BY_BOARD.cocina[4]).toBe("pdf_guia");
    expect(MANDATORY_STATIONS_BY_BOARD.caja.slice(0, 4)).toEqual([
      "green1", "purple1", "yellow", "nieves",
    ]);
    expect(MANDATORY_STATIONS_BY_BOARD.caja[4]).toBe("mana");
    expect(isDefaultMandatory("pdf_guia")).toBe(true);
    expect(isDefaultMandatory("mana")).toBe(true);
    expect(isDefaultMandatory("pdf_cyrl")).toBe(false);

    const shift = {
      id: "ada",
      date,
      startAt: chicagoHourStart(date, 9).toISOString(),
      endAt: chicagoHourStart(date, 17).toISOString(),
      assignments: [] as { stationId: string; hourStart: string }[],
    };
    const hours = [10, 11, 12];
    const gaps = uncoveredMandatory({
      stationIds: [...MANDATORY_STATIONS_BY_BOARD.cocina],
      hours,
      date,
      shifts: [shift],
    });
    expect(gaps.some((gap) => gap.hour < MANDATORY_GAP_START)).toBe(false);
    expect(gaps.some((gap) => gap.stationId === "pdf_guia" && gap.hour === 11)).toBe(true);
    expect(gaps.some((gap) => gap.stationId === "pdf_guia" && gap.hour === 10)).toBe(false);
    expect(gaps.filter((gap) => gap.hour === 12).map((gap) => gap.stationId)).toEqual([
      "pdf_tq1r", "pdf_tf1r", "pdf_pr1e", "pdf_br1a", "pdf_guia",
    ]);

    const guia = await setMandatoryMark({
      date, stationId: "pdf_guia", on: false, actor: { id: "s15", name: "S15", route: "test" },
    });
    const manager = await setMandatoryMark({
      date, stationId: "mana", on: false, actor: { id: "s15", name: "S15", route: "test" },
    });
    expect(guia).toEqual({ ok: false, status: 400, error: "That station is already mandatory" });
    expect(manager).toEqual({ ok: false, status: 400, error: "That station is already mandatory" });
  });
});

describe("S15 wall tiles and ability columns", () => {
  it("keeps Carne, Rellenar, and Carne y Relleno as three station columns", () => {
    expect(PAINT_FAMILIES.carneRelleno).toEqual(["pdf_crne", "pdf_rlno", "pdf_cyrl"]);
    expect(KITCHEN_LOAD_STATIONS.find((row) => row.id === "carne")?.seatIds).toEqual(["pdf_crne"]);
    const keys = cocinaAbilityColumns().map((column) => column.key);
    expect(keys.filter((key) => key === "pdf_crne" || key === "pdf_rlno" || key === "pdf_cyrl")).toEqual([
      "pdf_crne", "pdf_rlno", "pdf_cyrl",
    ]);
    expect(keys.includes("carneRelleno")).toBe(false);
  });

  it("draws a staffed station in board order and skips an empty seat and off hours", () => {
    const stations = [{ id: "yellow" }, { id: "green1" }, { id: "blue" }];
    expect(wallTilesForHour(stations, new Set(["blue", "yellow"]), true).map((row) => row.id)).toEqual([
      "yellow", "blue",
    ]);
    expect(wallTilesForHour(stations, new Set(["yellow"]), false)).toEqual([]);
    expect(wallTilesForHour(stations, new Set(), true)).toEqual([]);
  });
});
