import { formatDateBarLabel } from "@/lib/date-format";
import type { Locale } from "@/lib/i18n";

/**
 * Kitchen words for NEXT dates and times. Hand-rolled like the floor's date
 * bar: the exact words must not depend on the tablet's ICU data.
 */

const WEEKDAYS_LONG: Record<Locale, string[]> = {
  es: ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};

const MONTHS_LONG: Record<Locale, string[]> = {
  es: [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ],
  en: [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ],
};

function parts(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** Whole calendar days from `today` to `ymd` (both YYYY-MM-DD, Chicago days). */
export function daysFrom(today: string, ymd: string): number {
  const a = parts(today);
  const b = parts(ymd);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** "lun 28 sep", plus the year only when it is not this year. */
export function shortDay(ymd: string, today: string, locale: Locale): string {
  const label = formatDateBarLabel(ymd, locale);
  return ymd.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${ymd.slice(0, 4)}`;
}

/** "Lunes 28 de septiembre" / "Monday, September 28" (year when not this year). */
export function dayHeading(ymd: string, today: string, locale: Locale): string {
  const { y, m, d, dow } = parts(ymd);
  const year = String(y) === today.slice(0, 4) ? "" : ` ${y}`;
  return locale === "es"
    ? `${WEEKDAYS_LONG.es[dow]} ${d} de ${MONTHS_LONG.es[m - 1]}${year ? ` de${year}` : ""}`
    : `${WEEKDAYS_LONG.en[dow]}, ${MONTHS_LONG.en[m - 1]} ${d}${year ? `,${year}` : ""}`;
}

export type Urgency = "today" | "tomorrow" | "later";

export function urgency(today: string, ymd: string): Urgency {
  const n = daysFrom(today, ymd);
  if (n <= 0) return "today";
  if (n === 1) return "tomorrow";
  return "later";
}

/** HOY / MAÑANA / en N días (TODAY / TOMORROW / in N days). */
export function relativeDay(today: string, ymd: string, locale: Locale): string {
  const n = daysFrom(today, ymd);
  if (locale === "es") return n <= 0 ? "HOY" : n === 1 ? "MAÑANA" : `en ${n} días`;
  return n <= 0 ? "TODAY" : n === 1 ? "TOMORROW" : `in ${n} days`;
}

/** "10:50 am", "1:05 pm", "12:10 am" from a 24-hour HH:MM. */
export function time12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "septiembre 2026" / "September 2026" for the month view title. */
export function monthTitle(ymd: string, locale: Locale): string {
  const { y, m } = parts(ymd);
  return `${MONTHS_LONG[locale][m - 1]} ${y}`;
}
