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

export type HandoffBinding =
  | { state: "live"; overlay: SliceOverlay }
  | { state: "lost" }
  | { state: "none" };

/**
 * The handoff that put this named cover on the breaker's star.
 * Newest first. A live row binds even when its window has already ended,
 * so a later quarter can drop the name. A cancelled or import-ended row
 * is a lost binding when no live row seats this cover. No such row means
 * a manual name, which is not a handoff.
 */
export function handoffBinding(
  overlays: readonly SliceOverlay[],
  coverEmployeeId: string,
  breakerStationId: string | null,
  starStationIds: readonly string[],
): HandoffBinding {
  if (!breakerStationId || !starStationIds.includes(breakerStationId)) return { state: "none" };
  let lost = false;
  for (const overlay of overlays) {
    if (overlay.kind !== "switch" && overlay.kind !== "add") continue;
    if (!seatsCover(overlay, coverEmployeeId, breakerStationId)) continue;
    if (overlay.cancelledAt) {
      lost = true;
      continue;
    }
    return { state: "live", overlay };
  }
  return lost ? { state: "lost" } : { state: "none" };
}

/** The live handoff, if one still seats this cover. A lost binding is not one. */
export function findHandoffOverlay(
  overlays: readonly SliceOverlay[],
  coverEmployeeId: string,
  breakerStationId: string | null,
  starStationIds: readonly string[],
): SliceOverlay | null {
  const binding = handoffBinding(overlays, coverEmployeeId, breakerStationId, starStationIds);
  return binding.state === "live" ? binding.overlay : null;
}
