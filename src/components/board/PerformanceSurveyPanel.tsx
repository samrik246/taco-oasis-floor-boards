"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { performancePrompt, type Locale, type Messages } from "@/lib/i18n";

type QuestionDto = {
  id: string;
  prompt: string;
  kind: string;
  sortOrder: number;
};

type Props = {
  date: string;
  board: "caja" | "cocina";
  employeeId: string | null;
  employeeName: string | null;
  readonly: boolean;
  onSaved?: () => void;
  locale: Locale;
  t: Messages;
};

const CHOICES: Record<string, string[]> = {
  yes_no_na: ["yes", "no", "na"],
  finished_partial_none: ["finished", "partial", "none"],
  yes_no_maybe: ["yes", "no", "maybe"],
};

/**
 * Minimal end-of-shift / close-day survey for the selected person.
 */
export function PerformanceSurveyPanel({
  date,
  board,
  employeeId,
  employeeName,
  readonly,
  onSaved,
  locale,
  t,
}: Props) {
  const [open, setOpen] = useState(false);
  const [questions, setQuestions] = useState<QuestionDto[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !employeeId || !date) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/performance?date=${encodeURIComponent(date)}&board=${board}&employeeId=${encodeURIComponent(employeeId)}`,
      );
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as {
        questions: QuestionDto[];
        answers: { questionId: string; value: string }[];
      };
      setQuestions(data.questions ?? []);
      const map: Record<string, string> = {};
      for (const a of data.answers ?? []) map[a.questionId] = a.value;
      setAnswers(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, date, board, employeeId]);

  async function save() {
    if (!employeeId || readonly) return;
    setStatus(null);
    const res = await fetch("/api/performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        board,
        employeeId,
        answers: Object.entries(answers).map(([questionId, value]) => ({
          questionId,
          value,
        })),
      }),
    });
    if (!res.ok) {
      setStatus("Save failed");
      return;
    }
    setStatus("Saved");
    onSaved?.();
  }

  return (
    <div
      className="rounded-lg border-2 border-neutral-900 bg-white p-3"
      data-testid="performance-survey"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{t.performanceTitle}</h2>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 border-2"
          disabled={!employeeId || readonly}
          onClick={() => setOpen((v) => !v)}
          data-testid="performance-toggle"
        >
          {open ? t.cancel : t.openSurvey}
        </Button>
      </div>
      {!employeeId && (
        <p className="text-sm font-medium text-neutral-700">
          {t.pickPersonSurvey}
        </p>
      )}
      {open && employeeId && (
        <div className="flex flex-col gap-3" data-testid="performance-form">
          <p className="text-sm font-semibold">
            {employeeName ?? "—"} · {date}
          </p>
          {questions.map((q) => {
            const choices = CHOICES[q.kind];
            return (
              <label key={q.id} className="flex flex-col gap-1 text-sm">
                <span className="font-semibold">
                  {performancePrompt(locale, q.id, q.prompt)}
                </span>
                {choices ? (
                  <select
                    className="touch-target min-h-11 rounded-md border-2 border-neutral-800 bg-white px-2 font-medium"
                    value={answers[q.id] ?? ""}
                    disabled={readonly}
                    onChange={(e) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [q.id]: e.target.value,
                      }))
                    }
                    data-testid={`perf-q-${q.id}`}
                  >
                    <option value="">—</option>
                    {choices.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : (
                  <textarea
                    className="min-h-16 rounded-md border-2 border-neutral-800 bg-white px-2 py-2 font-medium"
                    value={answers[q.id] ?? ""}
                    disabled={readonly}
                    onChange={(e) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [q.id]: e.target.value,
                      }))
                    }
                    data-testid={`perf-q-${q.id}`}
                  />
                )}
              </label>
            );
          })}
          <Button
            type="button"
            className="min-h-11 border-2 border-neutral-900"
            disabled={readonly}
            onClick={() => void save()}
            data-testid="performance-save"
          >
            {t.saveAnswers}
          </Button>
          {status && (
            <p
              className={cn(
                "text-sm font-semibold",
                status === "Saved" ? "text-emerald-800" : "text-red-800",
              )}
            >
              {status}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
