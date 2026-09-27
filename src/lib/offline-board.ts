import { chicagoYmd } from "@/lib/schedule/build-schedule";

/**
 * Last successful floor snapshot, kept on the tablet.
 * Shown read-only when the home base or Wi-Fi drops. Never used to write.
 * Only today's board is kept: a manager planning a later day on this tablet
 * must not leave that plan behind for staff to see offline.
 */
const KEY = "taco-oasis-last-board-v1";

export type CachedFloorBoard = {
  version: 1;
  board: "caja" | "cocina";
  date: string;
  day: unknown;
  savedAt: string;
};

export function saveLastBoard(
  snapshot: Omit<CachedFloorBoard, "version" | "savedAt">,
  now: Date = new Date(),
) {
  if (typeof window === "undefined") return;
  if (snapshot.date !== chicagoYmd(now)) return;
  const payload: CachedFloorBoard = {
    version: 1,
    board: snapshot.board,
    date: snapshot.date,
    day: snapshot.day,
    savedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* private mode / quota — the live board still works */
  }
}

export function readLastBoard(now: Date = new Date()): CachedFloorBoard | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedFloorBoard;
    if (parsed.version !== 1 || !parsed.day || !parsed.date) return null;
    if (parsed.board !== "caja" && parsed.board !== "cocina") return null;
    // Today only. A cache written before this rule may hold a planned day,
    // and a wall offline since yesterday must not show yesterday as today.
    if (parsed.date !== chicagoYmd(now)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** A cached snapshot is only valid for the board that created it. */
export function readLastBoardFor(
  board: CachedFloorBoard["board"],
  now: Date = new Date(),
): CachedFloorBoard | null {
  const cached = readLastBoard(now);
  return cached?.board === board ? cached : null;
}
