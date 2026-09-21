import { prisma } from "@/lib/db";
import { hourGridHours } from "@/lib/hour-grid";
import { validateSalesPercents } from "@/lib/admin/validate";
import {
  buildRushForecast,
  dowFromYmd,
  type RushForecast,
} from "@/lib/rush/forecast";
import {
  historicalSaleRows,
  type HistoricalHourlySale,
  type RushBoard,
} from "@/lib/rush/historical-sales";

const SAMPLE_WEEKS = [1, 2, 3, 4];

export function isRushBoard(value: string): value is RushBoard {
  return value === "caja" || value === "cocina";
}

export async function loadSalesHistory(
  board?: RushBoard,
): Promise<HistoricalHourlySale[]> {
  const rows = await prisma.historicalHourlySale.findMany({
    where: board ? { board } : undefined,
  });
  if (rows.length === 0) {
    const fixture = historicalSaleRows();
    return board ? fixture.filter((row) => row.board === board) : fixture;
  }
  return rows.map((row) => ({
    board: row.board as RushBoard,
    dow: row.dow,
    hour: row.hour,
    week: row.week,
    salesCents: row.salesCents,
  }));
}

export async function forecastForDate(
  board: RushBoard,
  dateYmd: string,
): Promise<RushForecast> {
  const history = await loadSalesHistory(board);
  return buildRushForecast({ board, dateYmd, history });
}

/** Sunday 2026-09-20 plus `dow` days stays inside that week. */
export function sampleDateForDow(dow: number): string {
  const day = 20 + dow;
  return `2026-09-${String(day).padStart(2, "0")}`;
}

export async function readHourlySalesPercents(board: RushBoard, dow: number) {
  const history = await loadSalesHistory(board);
  const forecast = buildRushForecast({
    board,
    dateYmd: sampleDateForDow(dow),
    history,
  });
  if (dowFromYmd(sampleDateForDow(dow)) !== dow) {
    throw new Error(`sampleDateForDow(${dow}) is not weekday ${dow}`);
  }
  return {
    board,
    dow,
    hours: forecast.hours.map((hour) => ({
      hour: hour.hour,
      percent: hour.mean,
      rush: hour.rush,
      sampleCount: hour.sampleCount,
    })),
    rushHours: forecast.rushHours,
  };
}

/**
 * Replace one board+weekday with four identical sample weeks.
 * Percents must already add up to about 100% of that day — this does not
 * invent a total from a partial list.
 */
export async function saveHourlySalesPercents(opts: {
  board: RushBoard;
  dow: number;
  percents: { hour: number; percent: number }[];
}): Promise<
  | { ok: true; sales: Awaited<ReturnType<typeof readHourlySalesPercents>> }
  | { ok: false; error: string }
> {
  const checked = validateSalesPercents(opts.percents);
  if (!checked.ok) return checked;

  const hours = hourGridHours();
  await prisma.historicalHourlySale.deleteMany({
    where: { board: opts.board, dow: opts.dow },
  });
  await prisma.historicalHourlySale.createMany({
    data: SAMPLE_WEEKS.flatMap((week) =>
      hours.map((hour) => {
        const percent = checked.value.find((row) => row.hour === hour)?.percent ?? 0;
        return {
          board: opts.board,
          dow: opts.dow,
          hour,
          week,
          salesCents: Math.round(percent * 100),
        };
      }),
    ),
  });

  return { ok: true, sales: await readHourlySalesPercents(opts.board, opts.dow) };
}
