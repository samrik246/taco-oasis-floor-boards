/**
 * Default close-day / end-of-shift performance questions (Kitchen seed).
 * Editable later via admin CMS — v1 is seed constants + stored answers.
 */

export type PerformanceAnswerType = "yes_no_na" | "finished_partial_none" | "yes_no_maybe" | "free_note";

export type PerformanceQuestionDef = {
  id: string;
  prompt: string;
  answerType: PerformanceAnswerType;
  required: boolean;
  sortOrder: number;
};

export const DEFAULT_PERFORMANCE_QUESTIONS: readonly PerformanceQuestionDef[] = [
  {
    id: "stay_on_station",
    prompt:
      "Did this person stay on station when traffic was Busy/Slammed?",
    answerType: "yes_no_na",
    required: true,
    sortOrder: 0,
  },
  {
    id: "finished_tareas",
    prompt: "Did they finish assigned tareas or leave them hanging?",
    answerType: "finished_partial_none",
    required: true,
    sortOrder: 1,
  },
  {
    id: "seat_tomorrow",
    prompt: "Would you seat them on the same position tomorrow?",
    answerType: "yes_no_maybe",
    required: true,
    sortOrder: 2,
  },
  {
    id: "free_note",
    prompt: "Free note (optional)",
    answerType: "free_note",
    required: false,
    sortOrder: 3,
  },
] as const;

export const YES_NO_NA = ["yes", "no", "na"] as const;
export const FINISHED_PARTIAL_NONE = ["finished", "partial", "none"] as const;
export const YES_NO_MAYBE = ["yes", "no", "maybe"] as const;

export function isValidAnswerForQuestion(
  questionId: string,
  value: string,
): boolean {
  const q = DEFAULT_PERFORMANCE_QUESTIONS.find((x) => x.id === questionId);
  if (!q) return false;
  switch (q.answerType) {
    case "yes_no_na":
      return (YES_NO_NA as readonly string[]).includes(value);
    case "finished_partial_none":
      return (FINISHED_PARTIAL_NONE as readonly string[]).includes(value);
    case "yes_no_maybe":
      return (YES_NO_MAYBE as readonly string[]).includes(value);
    case "free_note":
      return true;
    default:
      return false;
  }
}
