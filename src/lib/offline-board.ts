/**
 * Last successful floor snapshot, kept on the tablet.
 * Shown read-only when the home base or Wi-Fi drops. Never used to write.
 */
const KEY = "taco-oasis-last-board-v1";

export type CachedFloorBoard = {
  version: 1;
  board: "caja" | "cocina";
  date: string;
  day: unknown;
  savedAt: string;
};

export function saveLastBoard(snapshot: Omit<CachedFloorBoard, "version" | "savedAt">) {
  if (typeof window === "undefined") return;
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

export function readLastBoard(): CachedFloorBoard | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedFloorBoard;
    if (parsed.version !== 1 || !parsed.day || !parsed.date) return null;
    if (parsed.board !== "caja" && parsed.board !== "cocina") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** A cached snapshot is only valid for the board that created it. */
export function readLastBoardFor(
  board: CachedFloorBoard["board"],
): CachedFloorBoard | null {
  const cached = readLastBoard();
  return cached?.board === board ? cached : null;
}
