import fixture from "../../../fixtures/historical-hourly-sales.json";

export type RushBoard = "caja" | "cocina";

/** One historical sample: orders in a weekday+hour bucket for one past week. */
export type HistoricalHourlySale = {
  board: RushBoard;
  /** 0 = Sunday … 6 = Saturday */
  dow: number;
  hour: number;
  week: number;
  orders: number;
};

type ProfileKey = "weekday" | "weekend";

const hours = fixture.hours;
const weeks = fixture.weeks;

function profileKey(dow: number): ProfileKey {
  return dow === 0 || dow === 6 ? "weekend" : "weekday";
}

/**
 * Expand the compact fixture into one row per board × weekday × hour × sample week.
 * This is the same list `prisma/seed.ts` writes into HistoricalHourlySale.
 */
export function historicalSaleRows(): HistoricalHourlySale[] {
  const rows: HistoricalHourlySale[] = [];
  const boards: RushBoard[] = ["caja", "cocina"];
  for (const board of boards) {
    for (let dow = 0; dow <= 6; dow++) {
      const profile = fixture.profiles[board][profileKey(dow)];
      if (profile.length !== hours.length) {
        throw new Error(
          `Historical sales profile ${board}/${profileKey(dow)} has ${profile.length} hours, expected ${hours.length}`,
        );
      }
      for (let i = 0; i < hours.length; i++) {
        const hour = hours[i]!;
        const base = profile[i]!;
        for (const sample of weeks) {
          rows.push({
            board,
            dow,
            hour,
            week: sample.week,
            orders: base + sample.delta,
          });
        }
      }
    }
  }
  return rows;
}
