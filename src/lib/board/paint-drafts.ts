import type { PaintEdit } from "@/lib/assignments/paint";

const PREFIX = "taco-oasis-paint-draft-v1";

type Board = "caja" | "cocina";
export type StoredPaintDraft = { version: 1; updatedAt: string; edits: PaintEdit[] };

function draftKey(managerId: string, board: Board, date: string): string {
  return `${PREFIX}:${encodeURIComponent(managerId)}:${board}:${date}`;
}

function indexKey(managerId: string, board: Board): string {
  return `${PREFIX}:dates:${encodeURIComponent(managerId)}:${board}`;
}

function readIndex(managerId: string, board: Board): string[] {
  try {
    const dates = JSON.parse(window.localStorage.getItem(indexKey(managerId, board)) ?? "[]") as unknown;
    return Array.isArray(dates) ? dates.filter((date): date is string =>
      typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date),
    ) : [];
  } catch {
    return [];
  }
}

function validEdit(value: unknown): value is PaintEdit {
  if (!value || typeof value !== "object") return false;
  const edit = value as Partial<PaintEdit>;
  return typeof edit.shiftId === "string" && Number.isInteger(edit.hour) &&
    edit.expectedShift != null &&
    typeof edit.expectedShift.startAt === "string" &&
    typeof edit.expectedShift.endAt === "string" &&
    typeof edit.expectedShift.employeeId === "string" &&
    typeof edit.expectedShift.sourcePosition === "string" &&
    (edit.expected === null || (
      edit.expected != null && typeof edit.expected.id === "string" &&
      typeof edit.expected.stationId === "string"
    )) && (edit.stationId === null || typeof edit.stationId === "string");
}

/** Only this manager's draft for this board and date is read after unlock. */
export function readPaintDraft(managerId: string, board: Board, date: string): StoredPaintDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(draftKey(managerId, board, date));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPaintDraft>;
    if (parsed.version !== 1 || !Array.isArray(parsed.edits) || parsed.edits.length > 500 ||
        !parsed.edits.every(validEdit)) return null;
    return { version: 1, updatedAt: parsed.updatedAt ?? "", edits: parsed.edits };
  } catch {
    return null;
  }
}

/** Kept locally only; this does not call an assignment route or publish a cell. */
export function writePaintDraft(managerId: string, board: Board, date: string, edits: PaintEdit[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = draftKey(managerId, board, date);
    const index = indexKey(managerId, board);
    const known = new Set(readIndex(managerId, board));
    if (edits.length === 0) {
      window.localStorage.removeItem(key);
      known.delete(date);
    } else {
      if (edits.length > 500) return false;
      known.add(date);
      window.localStorage.setItem(key, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), edits }));
    }
    window.localStorage.setItem(index, JSON.stringify([...known].sort()));
    return true;
  } catch {
    return false;
  }
}

/** Manager-only date picker can include a draft after WIW removes that date. */
export function paintDraftDates(managerId: string, board: Board): string[] {
  if (typeof window === "undefined") return [];
  try {
    return readIndex(managerId, board).filter((date) => readPaintDraft(managerId, board, date) != null);
  } catch {
    return [];
  }
}
