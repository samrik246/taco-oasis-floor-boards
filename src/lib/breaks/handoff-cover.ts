import type { SliceOverlay, SlicePaint } from "@/lib/slices/day-slices";

const HOUR_MS = 60 * 60 * 1000;

/** The overlay covers this break window from its start through its end. */
export function overlayCoversWindow(
  overlay: { startAt: Date; endAt: Date },
  start: Date,
  end: Date,
): boolean {
  return overlay.startAt.getTime() <= start.getTime()
    && overlay.endAt.getTime() >= end.getTime();
}

/** Paint seat at this instant. Same hour rule the slice engine uses. */
export function paintStationAt(
  paints: readonly SlicePaint[],
  employeeId: string,
  shiftId: string,
  at: Date,
): string | null {
  const t = at.getTime();
  for (const paint of paints) {
    if (paint.employeeId !== employeeId || paint.shiftId !== shiftId) continue;
    const start = paint.hourStart.getTime();
    if (t >= start && t < start + HOUR_MS) return paint.stationId;
  }
  return null;
}

function seatsCover(overlay: SliceOverlay, coverId: string, stationId: string): boolean {
  if (overlay.kind === "add") {
    return overlay.stationId === stationId
      && (overlay.employeeId === coverId || overlay.partnerEmployeeId === coverId);
  }
  if (overlay.kind === "switch") {
    if (overlay.employeeId === coverId && overlay.stationId === stationId) return true;
    if (overlay.partnerEmployeeId === coverId && overlay.fromStationId === stationId) return true;
  }
  return false;
}

/**
 * The handoff that put this named cover on the breaker's star.
 * Newest first. A cancelled row is skipped. A window that has already
 * ended still binds, so a later quarter can drop the name.
 */
export function findHandoffOverlay(
  overlays: readonly SliceOverlay[],
  coverEmployeeId: string,
  breakerStationId: string | null,
  starStationIds: readonly string[],
): SliceOverlay | null {
  if (!breakerStationId || !starStationIds.includes(breakerStationId)) return null;
  for (const overlay of overlays) {
    if (overlay.cancelledAt) continue;
    if (overlay.kind !== "switch" && overlay.kind !== "add") continue;
    if (seatsCover(overlay, coverEmployeeId, breakerStationId)) return overlay;
  }
  return null;
}
