/** Shared beat: the page polls, and the host reads C1, on this interval. */
export const NEXT_POLL_MS = 5 * 60 * 1000;

/** No good read for this long: say so on the page and on the Horario strip. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * The read is stale when the payload says so, when fetchedAt is missing,
 * or when it is older than STALE_AFTER_MS. Matches the check NextOrders used
 * before this module existed, including a non-empty unparseable timestamp.
 */
export function readIsStale(
  stale: boolean,
  fetchedAt: string | null | undefined,
  nowMs: number,
): boolean {
  const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : null;
  return stale || fetchedMs == null || nowMs - fetchedMs > STALE_AFTER_MS;
}
