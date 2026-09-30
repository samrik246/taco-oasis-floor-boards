import { SLICE_COUNT, sliceStart } from "@/lib/slices/day-slices";

export type OverlayWindowMode = "whole" | "rest" | "quarters";

/** Whole shift, the rest from the next quarter boundary, or chosen quarter bounds inside the shift. */
export function resolveOverlayWindow(input: {
  mode: OverlayWindowMode;
  date: string;
  shiftStart: Date;
  shiftEnd: Date;
  now: Date;
  quarterStart?: Date | null;
  quarterEnd?: Date | null;
}): { startAt: Date; endAt: Date } | null {
  if (input.shiftEnd.getTime() <= input.shiftStart.getTime()) return null;
  if (input.mode === "whole") {
    return { startAt: input.shiftStart, endAt: input.shiftEnd };
  }
  if (input.mode === "rest") {
    let boundary: Date | null = null;
    for (let index = 0; index <= SLICE_COUNT; index += 1) {
      const at = sliceStart(input.date, index);
      if (at.getTime() >= input.now.getTime()) {
        boundary = at;
        break;
      }
    }
    if (!boundary) return null;
    const startAt = boundary.getTime() > input.shiftStart.getTime() ? boundary : input.shiftStart;
    if (startAt.getTime() >= input.shiftEnd.getTime()) return null;
    return { startAt, endAt: input.shiftEnd };
  }
  const startAt = input.quarterStart ?? null;
  const endAt = input.quarterEnd ?? null;
  if (!startAt || !endAt || endAt.getTime() <= startAt.getTime()) return null;
  if (!isSliceBoundary(input.date, startAt) || !isSliceBoundary(input.date, endAt)) return null;
  if (startAt.getTime() < input.shiftStart.getTime() || endAt.getTime() > input.shiftEnd.getTime()) return null;
  return { startAt, endAt };
}

function isSliceBoundary(date: string, instant: Date): boolean {
  const time = instant.getTime();
  for (let index = 0; index <= SLICE_COUNT; index += 1) {
    if (sliceStart(date, index).getTime() === time) return true;
  }
  return false;
}

/** Quarter starts a person can pick, from the shift start through its end. */
export function quarterBounds(date: string, shiftStart: Date, shiftEnd: Date): Date[] {
  const bounds: Date[] = [];
  for (let index = 0; index <= SLICE_COUNT; index += 1) {
    const at = sliceStart(date, index);
    if (at.getTime() < shiftStart.getTime()) continue;
    if (at.getTime() > shiftEnd.getTime()) break;
    bounds.push(at);
  }
  return bounds;
}
