import type { Locale } from "./i18n";

/**
 * The operator's floor-language choice, remembered per device.
 * Independent of `localeForBoard` (board seed/Wall-mode language) — this is
 * the manager's own preference, not tied to caja vs. cocina.
 */
const KEY = "taco-oasis-locale-v1";

export function defaultLocalePreference(): Locale {
  return "es";
}

export function readLocalePreference(): Locale {
  if (typeof window === "undefined") return defaultLocalePreference();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "en" || raw === "es") return raw;
  } catch {
    /* private mode / quota — fall back to the default */
  }
  return defaultLocalePreference();
}

export function saveLocalePreference(locale: Locale) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, locale);
  } catch {
    /* private mode / quota — the toggle still works for this session */
  }
}
