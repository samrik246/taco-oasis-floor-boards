import type { Locale } from "@/lib/i18n";

/** Per-tablet SQUARE NEXT view choices, kept in the tablet's own storage. */
const KEY = "taco-oasis-next-prefs-v1";

export type NextView = "month" | "week" | "list";
export type NextColumn = "guests" | "fulfill" | "ready" | "modifiers";

export type NextPrefs = {
  view: NextView;
  locale: Locale;
  columns: Record<NextColumn, boolean>;
};

export const NEXT_COLUMNS: NextColumn[] = ["guests", "fulfill", "ready", "modifiers"];

export const DEFAULT_PREFS: NextPrefs = {
  view: "month",
  locale: "es",
  columns: { guests: true, fulfill: true, ready: true, modifiers: true },
};

/** Anything unreadable falls back to the default, field by field. */
export function parsePrefs(raw: string | null): NextPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<NextPrefs>;
    const view: NextView = p.view === "week" || p.view === "list" ? p.view : "month";
    const locale: Locale = p.locale === "en" ? "en" : "es";
    const columns = { ...DEFAULT_PREFS.columns };
    for (const c of NEXT_COLUMNS) {
      if (typeof p.columns?.[c] === "boolean") columns[c] = p.columns[c];
    }
    return { view, locale, columns };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function readPrefs(): NextPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    return parsePrefs(window.localStorage.getItem(KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: NextPrefs) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — the page still works for this visit */
  }
}
