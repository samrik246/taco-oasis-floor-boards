export type BreakChoice = { startAt: string; endAt: string };

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
