import type { CachedFloorBoard } from "@/lib/offline-board";

/**
 * A failed board fetch is always offline/read-only. A cache is optional and may
 * only supply display data for the board that requested it.
 */
export function offlineRefreshState<T>(
  board: CachedFloorBoard["board"],
  cached: Omit<CachedFloorBoard,"version"> & {version:1|2} | null,
): { offline: true; day: T | null; date: string | null } {
  if (cached?.board === board && cached.day) {
    return { offline: true, day: cached.day as T, date: cached.date };
  }
  return { offline: true, day: null, date: null };
}

/** A successful retry is live again and may restore editing. */
export function liveRefreshState<T>(day: T): { offline: false; day: T } {
  return { offline: false, day };
}

/** Reject a late response once the user has selected another board or date. */
export function isCurrentBoardRequest(
  active: { board: CachedFloorBoard["board"]; date: string },
  requested: { board: CachedFloorBoard["board"]; date: string },
): boolean {
  return active.board === requested.board && active.date === requested.date;
}

/**
 * Reject a late day response once the desk token has changed.
 * Lock clears the token, so an owner fetch that finishes after lock must not
 * repaint the same board and date.
 */
export function isCurrentRequestToken(
  active: string | null,
  requested: string | null,
): boolean {
  return active === requested;
}

/**
 * What a side panel (return prompts, tareas) does with a response. A late
 * response for another board or date is dropped; a 401 (the day needs a
 * manager) clears the panel, so a planned day's names never stay on a staff
 * screen; any other failure keeps the panel (offline today).
 */
export function panelResponse(
  status: number,
  active: { board: CachedFloorBoard["board"]; date: string },
  requested: { board: CachedFloorBoard["board"]; date: string },
): "apply" | "clear" | "drop" | "keep" {
  if (!isCurrentBoardRequest(active, requested)) return "drop";
  if (status === 401) return "clear";
  return status >= 200 && status < 300 ? "apply" : "keep";
}

/**
 * A held forecast only counts for the board and date it was fetched for. The
 * wall keeps its last forecast when a refresh fails (offline), so after
 * midnight yesterday's weekday forecast must not raise today's rush notice.
 */
export function forecastForScreen<F>(
  held: { board: CachedFloorBoard["board"]; date: string; forecast: F } | null,
  active: { board: CachedFloorBoard["board"]; date: string },
): F | null {
  if (!held || !isCurrentBoardRequest(active, held)) return null;
  return held.forecast;
}
