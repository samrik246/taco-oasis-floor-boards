/**
 * Default end-of-shift / close-day performance questions (kitchen-seed-content).
 * Store per employee + date + board.
 */

export type PerformanceQuestionSeed = {
  id: string;
  prompt: string;
  sortOrder: number;
  /** yes_no_na | finished_partial_none | yes_no_maybe | free_text */
  kind: "yes_no_na" | "finished_partial_none" | "yes_no_maybe" | "free_text";
};

export const DEFAULT_PERFORMANCE_QUESTIONS: readonly PerformanceQuestionSeed[] =
  [
    {
      id: "pq_stayed_on_station",
      prompt:
        "Did this person stay on station when traffic was Busy/Slammed?",
      sortOrder: 0,
      kind: "yes_no_na",
    },
    {
      id: "pq_tareas_finished",
      prompt: "Did they finish assigned tareas or leave them hanging?",
      sortOrder: 1,
      kind: "finished_partial_none",
    },
    {
      id: "pq_seat_tomorrow",
      prompt: "Would you seat them on the same position tomorrow?",
      sortOrder: 2,
      kind: "yes_no_maybe",
    },
    {
      id: "pq_free_note",
      prompt: "Free note (optional)",
      sortOrder: 3,
      kind: "free_text",
    },
  ] as const;
