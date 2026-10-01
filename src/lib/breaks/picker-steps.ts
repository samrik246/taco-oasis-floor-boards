import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { TIMEZONE } from "@/lib/constants";
import {
  BREAK_QUARTER_BLOCKED,
  BREAK_QUARTER_OUTSIDE,
  BREAK_QUARTER_TAKEN,
} from "@/lib/breaks/messages";

export type BreakChoice = { startAt: string; endAt: string };

const QUARTER_MS = 15 * 60_000;

export type QuarterReason = typeof BREAK_QUARTER_BLOCKED | typeof BREAK_QUARTER_TAKEN | typeof BREAK_QUARTER_OUTSIDE | "No disponible";

export type QuarterFace = {
  startAt: string;
  disabled: boolean;
  reason: QuarterReason | null;
};

/** One entry per start. Lengths for that start stay on the second step. */
export function breakStartChoices(slots: readonly BreakChoice[]): string[] {
  const starts: string[] = [];
  for (const slot of slots) {
    if (!starts.includes(slot.startAt)) starts.push(slot.startAt);
  }
  return starts;
}

export function breakLengthsForStart(slots: readonly BreakChoice[], startAt: string): BreakChoice[] {
  return slots.filter((slot) => slot.startAt === startAt);
}

export function breakLengthMinutes(slot: BreakChoice): number {
  return Math.round((new Date(slot.endAt).getTime() - new Date(slot.startAt).getTime()) / 60_000);
}

/** Full allowance when that length is offered; otherwise the longest valid length. */
export function preferredBreakLength(slots: readonly BreakChoice[], allowanceMinutes: number): BreakChoice | null {
  if (slots.length === 0) return null;
  const exact = slots.find((slot) => breakLengthMinutes(slot) === allowanceMinutes);
  if (exact) return exact;
  let best = slots[0]!;
  for (const slot of slots) {
    if (breakLengthMinutes(slot) > breakLengthMinutes(best)) best = slot;
  }
  return best;
}

export function breakSaveLine(slot: BreakChoice, clock: (iso: string) => string): string {
  return `${clock(slot.startAt)} a ${clock(slot.endAt)}, ${breakLengthMinutes(slot)} min`;
}

/** Staff-board kiosk button. `from=board` is the return marker; the spare tablet omits it. */
export function staffBreakHref(board: "caja" | "cocina"): string {
  return `/descansos?board=${board}&kiosk=1&from=board`;
}

/** Where a board-button visit goes after save, clear, or idle. Spare-tablet visits stay put. */
export function boardKioskReturnHref(from: string | null, board: string | null): string | null {
  if (from !== "board") return null;
  if (board !== "caja" && board !== "cocina") return null;
  return `/?board=${board}&kiosk=1`;
}

/** Pintar shows one Descanso control on the person's first live row, today, while the editor can write. */
export function showDescansoButton(input: {
  readonly: boolean;
  openDate: string;
  today: string;
  superseded: boolean;
  laterShiftOfPerson: boolean;
}): boolean {
  return !input.readonly
    && input.openDate === input.today
    && !input.superseded
    && !input.laterShiftOfPerson;
}

/** First name, then the windows, then the allowance. The staff screen keeps its own line. */
export function managerShiftLine(
  firstName: string,
  shifts: readonly { startAt: string; endAt: string }[],
  allowanceMinutes: number,
  clock: (iso: string) => string,
): string {
  const ordered = [...shifts].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const windows = ordered.map((shift) => `${clock(shift.startAt)} a ${clock(shift.endAt)}`).join(" y ");
  const minutes = `Le tocan ${allowanceMinutes} minutos.`;
  if (!windows) return `${firstName}. ${minutes}`;
  return `${firstName}. ${windows}. ${minutes}`;
}

export function shiftAllowanceLine(
  shifts: readonly { startAt: string; endAt: string }[],
  allowanceMinutes: number,
  clock: (iso: string) => string,
): string {
  const ordered = [...shifts].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const windows = ordered.map((shift) => `${clock(shift.startAt)} a ${clock(shift.endAt)}`).join(" y ");
  return `Tu turno: ${windows}. Te tocan ${allowanceMinutes} minutos.`;
}

function quarterInside(shifts: readonly { startAt: string; endAt: string }[], startMs: number): boolean {
  const endMs = startMs + QUARTER_MS;
  return shifts.some((shift) => startMs >= Date.parse(shift.startAt) && endMs <= Date.parse(shift.endAt));
}

/** Chicago :00, :15, :30, :45. An 8:10 shift still shares the 8:15 grid with offeredBreakSlots. */
function floorChicagoQuarter(ms: number): number {
  const local = toZonedTime(new Date(ms), TIMEZONE);
  const minutes = local.getMinutes();
  local.setMinutes(minutes - (minutes % 15), 0, 0);
  return fromZonedTime(local, TIMEZONE).getTime();
}

/** Every calendar quarter from the first shift to the last, with the word a cook sees. */
export function breakQuarterFaces(input: {
  shifts: readonly { startAt: string; endAt: string }[];
  slots: readonly { startAt: string }[];
  blocked: readonly { startAt: string; reason: "blackout" | "overlap" }[];
}): QuarterFace[] {
  if (input.shifts.length === 0) return [];
  const open = new Set(input.slots.map((slot) => Date.parse(slot.startAt)));
  const blocked = new Map(input.blocked.map((quarter) => [Date.parse(quarter.startAt), quarter.reason]));
  const startMs = floorChicagoQuarter(Math.min(...input.shifts.map((shift) => Date.parse(shift.startAt))));
  const endMs = Math.max(...input.shifts.map((shift) => Date.parse(shift.endAt)));
  const faces: QuarterFace[] = [];
  for (let at = startMs; at < endMs; at += QUARTER_MS) {
    const startAt = new Date(at).toISOString();
    if (open.has(at)) {
      faces.push({ startAt, disabled: false, reason: null });
      continue;
    }
    if (!quarterInside(input.shifts, at)) {
      faces.push({ startAt, disabled: true, reason: BREAK_QUARTER_OUTSIDE });
      continue;
    }
    const reason = blocked.get(at);
    if (reason === "blackout") faces.push({ startAt, disabled: true, reason: BREAK_QUARTER_BLOCKED });
    else if (reason === "overlap") faces.push({ startAt, disabled: true, reason: BREAK_QUARTER_TAKEN });
    else faces.push({ startAt, disabled: true, reason: "No disponible" });
  }
  return faces;
}
