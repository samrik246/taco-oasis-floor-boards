/**
 * The Friday-through-Thursday week that contains the restaurant's date today
 * (America/Chicago), and the file names that go with it.
 *
 * This is not the payroll contract's ISO-Monday rule (Monday minus 3 through
 * Monday plus 3): on a Friday, Saturday or Sunday that rule names the week
 * before, and the folder import would refuse it as WRONG_WEEK.
 */
import { addDays, format, parseISO } from "date-fns";
import { restaurantDate } from "@/lib/import/folder-import";

export type ExportWeek = {
  /** yyyy-MM-dd */
  friday: string;
  /** yyyy-MM-dd */
  thursday: string;
};

const FRIDAY = 5;

export function exportWeekFor(now: Date): ExportWeek {
  const today = parseISO(restaurantDate(now));
  const back = (today.getDay() - FRIDAY + 7) % 7;
  const friday = addDays(today, -back);
  return {
    friday: format(friday, "yyyy-MM-dd"),
    thursday: format(addDays(friday, 6), "yyyy-MM-dd"),
  };
}

/** The name the folder import reads: `Schedule_for_<friday>_<thursday>.xlsx`. */
export function importFileName(week: ExportWeek): string {
  return `Schedule_for_${week.friday}_${week.thursday}.xlsx`;
}

/** The name When I Work gives the download, e.g. `Schedule for Sep 18, 2026 - Sep 24, 2026.xlsx`. */
export function expectedDownloadName(week: ExportWeek): string {
  const label = (ymd: string) => format(parseISO(ymd), "MMM d, yyyy");
  return `Schedule for ${label(week.friday)} - ${label(week.thursday)}.xlsx`;
}

/** The export dialog's date fields take MM/dd/yyyy. */
export function dialogDate(ymd: string): string {
  return format(parseISO(ymd), "MM/dd/yyyy");
}

/** The Friday-through-Thursday after `week`. */
export function followingWeek(week: ExportWeek): ExportWeek {
  const next = (ymd: string) => format(addDays(parseISO(ymd), 7), "yyyy-MM-dd");
  return { friday: next(week.friday), thursday: next(week.thursday) };
}
