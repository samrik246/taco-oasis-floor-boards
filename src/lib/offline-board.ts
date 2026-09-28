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

function employeeRecord(shift: unknown): Record<string, unknown> | null {
  if (!shift || typeof shift !== "object" || !("employee" in shift)) return null;
  const employee = (shift as { employee?: unknown }).employee;
  if (!employee || typeof employee !== "object") return null;
  return employee as Record<string, unknown>;
}

function dayRecord(day: unknown): Record<string, unknown> | null {
  if (!day || typeof day !== "object") return null;
  return day as Record<string, unknown>;
}

/** True when any shift still carries the owner-only abilities key. */
export function dayCarriesAbilities(day: unknown): boolean {
  if (!day || typeof day !== "object" || !("shifts" in day)) return false;
  const shifts = (day as { shifts?: unknown }).shifts;
  if (!Array.isArray(shifts)) return false;
  return shifts.some((shift) => {
    const employee = employeeRecord(shift);
    return employee != null && "abilities" in employee;
  });
}

/**
 * Drop `employee.abilities` and keep everything else, including `abilityBlocked`.
 * The caller's object is left unchanged.
 */
export function stripEmployeeAbilities<T>(day: T): T {
  if (!dayCarriesAbilities(day)) return day;
  const copy = structuredClone(day);
  const shifts = (copy as { shifts?: unknown }).shifts;
  if (!Array.isArray(shifts)) return copy;
  for (const shift of shifts) {
    const employee = employeeRecord(shift);
    if (employee && "abilities" in employee) delete employee.abilities;
  }
  return copy;
}

/** Manager-only day fields stay off the shared tablet, the same way levels do. */
export function stripSharedTabletDay<T>(day: T): T {
  const withoutAbilities = stripEmployeeAbilities(day);
  const record = dayRecord(withoutAbilities);
  if (!record || !("mandatory" in record)) return withoutAbilities;
  const copy = withoutAbilities === day ? structuredClone(withoutAbilities) : withoutAbilities;
  delete (copy as { mandatory?: unknown }).mandatory;
  return copy;
}

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
    day: stripSharedTabletDay(snapshot.day),
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
    if (!parsed || typeof parsed !== "object") return null;
    // An older build may have saved owner levels or one-day marks. Rewrite the
    // stored snapshot so a later staff read cannot find them, even when this
    // cache is not today.
    const record = dayRecord(parsed.day);
    if (dayCarriesAbilities(parsed.day) || (record != null && "mandatory" in record)) {
      parsed.day = stripSharedTabletDay(parsed.day);
      window.localStorage.setItem(KEY, JSON.stringify(parsed));
    }
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
