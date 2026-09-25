/**
 * Calendar math on plain YYYY-MM-DD strings, so the tablet's own time zone
 * never shifts a day. Weeks start on Sunday, as the kitchen's printed week does.
 */

function toUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  const d = toUtc(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

export function weekStart(ymd: string): string {
  return addDays(ymd, -toUtc(ymd).getUTCDay());
}

/** Seven days starting the Sunday on or before `ymd`. */
export function weekDays(ymd: string): string[] {
  const start = weekStart(ymd);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

export function addMonths(ymd: string, months: number): string {
  const d = toUtc(monthStart(ymd));
  d.setUTCMonth(d.getUTCMonth() + months);
  return fromUtc(d);
}

/** Whole weeks covering the month of `ymd`, Sunday first. */
export function monthGrid(ymd: string): string[][] {
  const first = monthStart(ymd);
  const month = first.slice(0, 7);
  const weeks: string[][] = [];
  let cursor = weekStart(first);
  while (weeks.length === 0 || cursor.slice(0, 7) === month) {
    weeks.push(weekDays(cursor));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export function groupByDate<T extends { event_date: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const list = map.get(item.event_date) ?? [];
    list.push(item);
    map.set(item.event_date, list);
  }
  return map;
}
