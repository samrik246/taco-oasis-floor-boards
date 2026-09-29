/**
 * Insert the Carne y Relleno station and its hidden ability column.
 * One transaction. A matching row is left alone. Any differing field
 * rolls the transaction back. No other station, setting, assignment,
 * mark, break, or position-map row is written.
 */

export const CARNE_RELLENO_STATION = {
  id: "pdf_cyrl",
  board: "cocina",
  label: "Carne y Relleno",
  color: "dark-orange",
  maxConcurrent: 1,
  sortOrder: 0,
  priority: null as number | null,
  shortCode: "CYRL",
};

export const CARNE_RELLENO_SETTING = {
  key: "pdf_cyrl",
  hidden: true,
  defaultLevel: "ok",
};

export type CarneRellenoStation = typeof CARNE_RELLENO_STATION;
export type CarneRellenoSetting = typeof CARNE_RELLENO_SETTING;
export type CarneRellenoStatus = "inserted" | "already" | "conflict" | "rolled_back";

export type CarneRellenoReport = {
  station: CarneRellenoStatus;
  setting: CarneRellenoStatus;
  conflict: string;
  station_after: CarneRellenoStation | null;
  setting_after: CarneRellenoSetting | null;
};

const STATION_FIELDS = [
  "board",
  "label",
  "color",
  "maxConcurrent",
  "sortOrder",
  "priority",
  "shortCode",
] as const;

type Tx = {
  station: {
    findUnique(args: { where: { id: string } }): Promise<CarneRellenoStation | null>;
    create(args: { data: CarneRellenoStation }): Promise<CarneRellenoStation>;
  };
  abilityColumnSetting: {
    findUnique(args: { where: { key: string } }): Promise<CarneRellenoSetting | null>;
    create(args: { data: CarneRellenoSetting }): Promise<CarneRellenoSetting>;
  };
};

export type CarneRellenoDb = {
  $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

export class CarneRellenoConflict extends Error {
  constructor(readonly report: CarneRellenoReport) {
    super(report.conflict);
    this.name = "CarneRellenoConflict";
  }
}

function stationConflict(row: CarneRellenoStation): string | null {
  for (const field of STATION_FIELDS) {
    if (row[field] !== CARNE_RELLENO_STATION[field]) return `station.${field}`;
  }
  return null;
}

function settingConflict(row: CarneRellenoSetting): string | null {
  if (row.hidden !== CARNE_RELLENO_SETTING.hidden) return "setting.hidden";
  if (row.defaultLevel !== CARNE_RELLENO_SETTING.defaultLevel) return "setting.defaultLevel";
  return null;
}

function stationTuple(row: CarneRellenoStation | null): CarneRellenoStation | null {
  if (!row) return null;
  return {
    id: row.id,
    board: row.board,
    label: row.label,
    color: row.color,
    maxConcurrent: row.maxConcurrent,
    sortOrder: row.sortOrder,
    priority: row.priority,
    shortCode: row.shortCode,
  };
}

function settingTuple(row: CarneRellenoSetting | null): CarneRellenoSetting | null {
  if (!row) return null;
  return { key: row.key, hidden: row.hidden, defaultLevel: row.defaultLevel };
}

export async function applyCarneRelleno(db: CarneRellenoDb): Promise<CarneRellenoReport> {
  return db.$transaction(async (tx) => {
    const station = await tx.station.findUnique({ where: { id: CARNE_RELLENO_STATION.id } });
    const setting = await tx.abilityColumnSetting.findUnique({ where: { key: CARNE_RELLENO_SETTING.key } });
    const stationField = station ? stationConflict(station) : null;
    const settingField = setting ? settingConflict(setting) : null;
    if (stationField || settingField) {
      throw new CarneRellenoConflict({
        station: stationField ? "conflict" : station ? "already" : "rolled_back",
        setting: settingField ? "conflict" : setting ? "already" : "rolled_back",
        conflict: stationField ?? settingField ?? "conflict",
        station_after: stationTuple(station),
        setting_after: settingTuple(setting),
      });
    }
    if (!station) await tx.station.create({ data: { ...CARNE_RELLENO_STATION } });
    if (!setting) await tx.abilityColumnSetting.create({ data: { ...CARNE_RELLENO_SETTING } });
    return {
      station: station ? "already" : "inserted",
      setting: setting ? "already" : "inserted",
      conflict: "none",
      station_after: { ...CARNE_RELLENO_STATION },
      setting_after: { ...CARNE_RELLENO_SETTING },
    };
  });
}

export function formatCarneRellenoReport(report: CarneRellenoReport): string {
  return [
    `station ${report.station}`,
    `setting ${report.setting}`,
    `conflict ${report.conflict}`,
    `station_after ${JSON.stringify(report.station_after)}`,
    `setting_after ${JSON.stringify(report.setting_after)}`,
  ].join("\n");
}
