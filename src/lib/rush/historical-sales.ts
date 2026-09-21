import fixture from "../../../fixtures/historical-hourly-sales.json";

export type RushBoard = "caja" | "cocina";

/**
 * One historical sample: sales dollars (stored as cents) in a weekday+hour
 * bucket for one past week. Rush math turns each week into a percent of
 * that day’s sales — these are not order counts.
 */
export type HistoricalHourlySale = {
  board: RushBoard;
  /** 0 = Sunday … 6 = Saturday */
  dow: number;
  hour: number;
  week: number;
  salesCents: number;
};

type ProfileKey = "weekday" | "weekend";

const hours = fixture.hours;
const weeks = fixture.weeks;

function profileKey(dow: number): ProfileKey {
  return dow === 0 || dow === 6 ? "weekend" : "weekday";
}

/**
 * Expand the compact fixture into one row per board × weekday × hour × sample week.
 * Fixture profile numbers are sample sales dollars. Stored as cents.
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
        const baseDollars = profile[i]!;
        for (const sample of weeks) {
          const dollars = baseDollars + sample.delta;
          rows.push({
            board,
            dow,
            hour,
            week: sample.week,
            salesCents: Math.round(dollars * 100),
          });
        }
      }
    }
  }
  return rows;
}
