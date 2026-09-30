/** UI state never changes the persisted booked/pending/ended vocabulary. */
export function breakState(row: { status: string; startAt: Date; endAt: Date }, now: Date) {
  if (row.status === "ended") return "ended" as const;
  if (row.status === "pending") return "pending" as const;
  if (row.endAt <= now) return "completed" as const;
  if (row.startAt <= now) return "on-break" as const;
  return "reserved" as const;
}
