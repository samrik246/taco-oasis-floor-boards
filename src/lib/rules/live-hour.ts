/**
 * Mirrors reconcile.ts's `hasStarted`: an hour is live/past once `now`
 * reaches its start. The server clock decides — never a client-supplied flag.
 */
export function isFutureHour(hourStart: Date, now: Date): boolean {
  return now.getTime() < hourStart.getTime();
}
