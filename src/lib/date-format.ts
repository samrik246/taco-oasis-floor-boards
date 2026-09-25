import type { Locale } from "./i18n";

// Hand-rolled, not Intl: the tablet's Chromium/Node ICU data isn't guaranteed
// to have es-MX short forms, and the exact literal "vie 25 sep" (no comma)
// must not depend on it.
const WEEKDAYS: Record<Locale, string[]> = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  es: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
};
const MONTHS: Record<Locale, string[]> = {
  en: [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ],
  es: [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ],
};

/**
 * "vie 25 sep" / "Fri 25 Sep" from a YYYY-MM-DD calendar date — pure
 * calendar-part arithmetic, no timezone conversion (the date is already the
 * board's day, not a UTC instant to reinterpret).
 */
export function formatDateBarLabel(dateYmd: string, locale: Locale): string {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[locale][dow]} ${d} ${MONTHS[locale][m - 1]}`;
}

/** One entry back in the imported date list, or null at (or past) the start. */
export function prevImportedDate(dates: string[], date: string): string | null {
  const idx = dates.indexOf(date);
  return idx > 0 ? dates[idx - 1] : null;
}

/** One entry forward in the imported date list, or null at (or past) the end. */
export function nextImportedDate(dates: string[], date: string): string | null {
  const idx = dates.indexOf(date);
  return idx >= 0 && idx < dates.length - 1 ? dates[idx + 1] : null;
}

/** Today if it's in the imported date list, otherwise null (not "nearest date"). */
export function resolveTodayInList(
  dates: string[],
  todayYmd: string,
): string | null {
  return dates.includes(todayYmd) ? todayYmd : null;
}
